import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  type CallInfo,
  Conversation,
  type ConversationClient,
  createCardan,
  defineTool,
  dropToolRounds,
  emptyUsage,
  type FinishReason,
  type GenerateResult,
  type ModelId,
  type Provider,
} from "../src/index.js";

function textResult(text: string, finishReason: FinishReason = "stop"): GenerateResult {
  return {
    message: { role: "assistant", content: [{ type: "text", text }] },
    text,
    finishReason,
    usage: emptyUsage(),
    raw: {},
  };
}

function toolCallResult(id: string, name: string, args: unknown): GenerateResult {
  return {
    message: { role: "assistant", content: [{ type: "tool_call", id, name, args }] },
    text: "",
    finishReason: "tool_calls",
    usage: emptyUsage(),
    raw: {},
  };
}

interface Call {
  model: string;
  toolChoice?: unknown;
  hasTools: boolean;
  output?: unknown;
}

/** A fake client that records each call and answers from a scripted function. */
class FakeClient implements ConversationClient {
  readonly calls: Call[] = [];
  constructor(
    private readonly script: (
      n: number,
      opts: Parameters<ConversationClient["generate"]>[0],
    ) => GenerateResult,
  ) {}
  generate(opts: Parameters<ConversationClient["generate"]>[0]): Promise<GenerateResult> {
    const n = this.calls.length;
    this.calls.push({
      model: opts.model,
      toolChoice: opts.toolChoice,
      hasTools: !!opts.tools?.length,
      output: opts.output,
    });
    return Promise.resolve(this.script(n, opts));
  }
}

test("ask appends user + assistant and returns the reply", async () => {
  const client = new FakeClient(() => textResult("hi there"));
  const c = new Conversation(client, { model: "test/a" });
  const res = await c.ask("hello");
  assert.equal(res.message.content[0]?.type === "text" && res.message.content[0].text, "hi there");
  assert.equal(c.messages.length, 2);
  assert.equal(c.messages[0]?.role, "user");
  assert.equal(c.messages[1]?.role, "assistant");
});

test("model is a default that can be overridden per turn and switched mid-conversation", async () => {
  const client = new FakeClient(() => textResult("ok"));
  const c = new Conversation(client, { model: "test/a" });
  await c.ask("1");
  await c.ask("2", { model: "test/b" });
  c.defaults.model = "test/b";
  await c.ask("3");
  assert.deepEqual(client.calls.map((x) => x.model), ["test/a", "test/b", "test/b"]);
});

test("tool loop runs handlers, feeds results back, and concludes", async () => {
  const client = new FakeClient((n) =>
    n === 0 ? toolCallResult("c1", "add", { a: 2, b: 3 }) : textResult("the sum is 5"),
  );
  let received: { a: number; b: number } | undefined;
  const add = defineTool(
    { name: "add", description: "add two numbers", parameters: z.object({ a: z.number(), b: z.number() }) },
    (args) => {
      received = args; // typed { a: number; b: number }
      return String(args.a + args.b);
    },
  );
  const c = new Conversation(client, { model: "test/a" });
  const res = await c.ask("add 2 and 3", { tools: [add] });

  assert.deepEqual(received, { a: 2, b: 3 });
  assert.equal(res.finishReason, "stop");
  // user, assistant(tool_call), tool(result), assistant(conclusion)
  assert.equal(c.messages.length, 4);
  const toolMsg = c.messages[2];
  assert.equal(toolMsg?.role, "tool");
  assert.equal(toolMsg?.content[0]?.type === "tool_result" && toolMsg.content[0].result, "5");
});

test("compact:true redacts tool results but keeps the tool-use trace", async () => {
  const client = new FakeClient((n) =>
    n === 0 ? toolCallResult("c1", "noop", {}) : textResult("done"),
  );
  const noop = defineTool({ name: "noop", parameters: z.object({}) }, () => "ran");
  const c = new Conversation(client, { model: "test/a" });
  await c.ask("go", { tools: [noop], compact: true });
  // user, assistant(tool_call), tool(result redacted), assistant("done")
  assert.equal(c.messages.length, 4);
  assert.equal(c.messages[1]?.content[0]?.type, "tool_call"); // provenance kept
  const toolMsg = c.messages[2];
  assert.equal(
    toolMsg?.content[0]?.type === "tool_result" && toolMsg.content[0].result,
    "[tool result omitted to save context]",
  );
});

test("compact with dropToolRounds keeps only the final conclusion", async () => {
  const client = new FakeClient((n) =>
    n === 0 ? toolCallResult("c1", "noop", {}) : textResult("done"),
  );
  const noop = defineTool({ name: "noop", parameters: z.object({}) }, () => "ran");
  const c = new Conversation(client, { model: "test/a" });
  await c.ask("go", { tools: [noop], compact: dropToolRounds });
  assert.equal(c.messages.length, 2);
  assert.equal(
    c.messages[1]?.content[0]?.type === "text" && c.messages[1].content[0].text,
    "done",
  );
});

test("maxRounds forces a tool-free final round", async () => {
  // Model always wants to call tools; maxRounds caps the loop.
  const client = new FakeClient(() => toolCallResult("c1", "noop", {}));
  const noop = defineTool({ name: "noop", parameters: z.object({}) }, () => "ran");
  const c = new Conversation(client, { model: "test/a" });
  await c.ask("go", { tools: [noop], maxRounds: 1 });
  // round 0: toolChoice auto; round 1 (== maxRounds): forced "none".
  assert.deepEqual(client.calls.map((x) => x.toolChoice), ["auto", "none"]);
});

test("ask with an output schema parses and validates the structured result", async () => {
  const schema = z.object({ n: z.number() });
  const client = new FakeClient(() => ({ ...textResult("{}"), output: { n: 7 } }));
  const c = new Conversation(client, { model: "test/a" });
  const res = await c.ask("emit", { output: { schema } });
  assert.deepEqual(res.output, { n: 7 }); // cast with `as Infer<typeof schema>` if desired
  assert.equal(client.calls[0]?.output !== undefined, true);
});

test("ask rejects combining tools with an output schema", async () => {
  const client = new FakeClient(() => textResult("unused"));
  const noop = defineTool({ name: "noop", parameters: z.object({}) }, () => "ran");
  const c = new Conversation(client, { model: "test/a" });
  await assert.rejects(
    () => c.ask("go", { tools: [noop], output: { schema: z.object({}) } }),
    /cannot combine `tools` with `output`/,
  );
  assert.equal(c.messages.length, 0); // rejected before mutating the transcript
  assert.equal(client.calls.length, 0);
});

test("onCall fires per call with a label/step tag, and on error", async () => {
  const infos: CallInfo[] = [];
  let throwNext = false;
  const client = new FakeClient(() => {
    if (throwNext) throw new Error("boom");
    return textResult("ok");
  });
  const c = new Conversation(client, {
    model: "test/a",
    label: "job",
    onCall: (i) => infos.push(i),
  });
  await c.ask("1", { step: "research" });
  assert.equal(infos[0]?.tag, "job/research");
  assert.equal(infos[0]?.finishReason, "stop");
  assert.equal(infos[0]?.error, undefined);

  throwNext = true;
  await assert.rejects(() => c.ask("2"));
  assert.equal(infos[1]?.tag, "job");
  assert.equal(infos[1]?.finishReason, undefined);
  assert.equal(infos[1]?.error instanceof Error, true);
});

test("cardan.conversation() binds config and routes provider/model", async () => {
  const provider: Provider = {
    name: "test",
    // The router strips the "test/" prefix; the bare model reaches the provider.
    generate: (o) => Promise.resolve(textResult(`echo:${o.model}`)),
    // deno-lint-ignore require-yield
    async *stream() {},
  };
  const cardan = createCardan({ providers: { test: provider } });
  const c = cardan.conversation({ model: "test/m" as ModelId });
  const res = await c.ask("hi");
  assert.equal(
    res.message.content[0]?.type === "text" && res.message.content[0].text,
    "echo:m",
  );
});
