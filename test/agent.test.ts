import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Agent,
  type ConversationClient,
  createCardan,
  defineTool,
  emptyUsage,
  type GenerateResult,
  type Memory,
  type Message,
  type Provider,
  type Usage,
} from "../src/index.js";

function usage(input: number, output: number): Usage {
  return { input: { total: input, details: {} }, output: { total: output, details: {} } };
}

function textResult(text: string, u: Usage = emptyUsage()): GenerateResult {
  return {
    message: { role: "assistant", content: [{ type: "text", text }] },
    text,
    finishReason: "stop",
    usage: u,
    raw: {},
  };
}

function toolCallResult(id: string, name: string, args: unknown, u: Usage): GenerateResult {
  return {
    message: { role: "assistant", content: [{ type: "tool_call", id, name, args }] },
    text: "",
    finishReason: "tool_calls",
    usage: u,
    raw: {},
  };
}

function systemText(messages: Message[]): string {
  const first = messages[0];
  if (first?.role !== "system") return "";
  const part = first.content[0];
  return part?.type === "text" ? part.text : "";
}

class FakeClient implements ConversationClient {
  readonly calls: { model: string; messages: Message[] }[] = [];
  constructor(
    private readonly script: (
      n: number,
      opts: Parameters<ConversationClient["generate"]>[0],
    ) => GenerateResult,
  ) {}
  generate(opts: Parameters<ConversationClient["generate"]>[0]): Promise<GenerateResult> {
    const n = this.calls.length;
    this.calls.push({ model: opts.model, messages: opts.messages });
    return Promise.resolve(this.script(n, opts));
  }
}

test("run starts a conversation, asks, and returns the reply", async () => {
  const client = new FakeClient(() => textResult("done"));
  const agent = new Agent(client, { name: "A", system: "you are A", model: "test/m" });
  const res = await agent.run("go");
  assert.equal(res.text, "done");
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0]?.model, "test/m");
  assert.equal(systemText(client.calls[0]!.messages), "you are A");
});

test("run returns usage accumulated across tool-loop rounds", async () => {
  const client = new FakeClient((n) =>
    n === 0
      ? toolCallResult("c1", "echo", { x: 1 }, usage(10, 5))
      : textResult("final", usage(20, 8)),
  );
  const echo = defineTool({ name: "echo", parameters: { type: "object" } }, () => "ok");
  const agent = new Agent(client, { name: "A", model: "test/m", tools: [echo] });
  const res = await agent.run("go");
  assert.equal(res.text, "final");
  assert.equal(client.calls.length, 2); // tool round + conclusion
  assert.equal(res.usage.input.total, 30); // 10 + 20, not just the last turn
  assert.equal(res.usage.output.total, 13); // 5 + 8
});

test("run injects recalled memory into system and observes the accumulated result", async () => {
  const observed: GenerateResult[] = [];
  const memory: Memory = {
    recall: () => "remember: prefers brevity",
    observe: (r) => {
      observed.push(r);
    },
  };
  const client = new FakeClient(() => textResult("ok", usage(3, 4)));
  const agent = new Agent(client, { name: "A", system: "base", model: "test/m", memory });
  const res = await agent.run("go");
  const sys = systemText(client.calls[0]!.messages);
  assert.match(sys, /base/);
  assert.match(sys, /prefers brevity/);
  assert.equal(observed.length, 1);
  assert.equal(observed[0], res);
  assert.equal(observed[0]?.usage.input.total, 3);
});

test("conversation() is preconfigured with identity but does not apply memory", async () => {
  let recalled = 0;
  const memory: Memory = {
    recall: () => {
      recalled++;
      return "X";
    },
    observe: () => {},
  };
  const client = new FakeClient(() => textResult("hi"));
  const agent = new Agent(client, { name: "A", system: "base", model: "test/m", memory });
  const conv = agent.conversation();
  await conv.ask("hello");
  assert.equal(recalled, 0); // memory untouched under manual driving
  assert.equal(systemText(client.calls[0]!.messages), "base");
  assert.equal(client.calls[0]?.model, "test/m");
});

test("per-call model overrides the spec model", async () => {
  const client = new FakeClient(() => textResult("ok"));
  const agent = new Agent(client, { name: "A", model: "test/default" });
  await agent.run("go", { model: "test/override" });
  assert.equal(client.calls[0]?.model, "test/override");
});

test("an agent with no model anywhere throws invalid_request", async () => {
  const client = new FakeClient(() => textResult("ok"));
  const agent = new Agent(client, { name: "A" });
  await assert.rejects(() => agent.run("go"), /no model/);
});

test("cardan.agent() builds an agent bound to the client", async () => {
  const fake: Provider = {
    name: "fake",
    generate: () => Promise.resolve(textResult("hi from fake")),
    async *stream() {},
  };
  const cardan = createCardan({ providers: { test: fake } });
  const agent = cardan.agent({ name: "A", model: "test/m" });
  const res = await agent.run("go");
  assert.equal(res.text, "hi from fake");
});
