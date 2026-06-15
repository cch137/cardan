import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Conversation,
  type ConversationContext,
  type ConversationClient,
  createFlow,
  emptyUsage,
  type FlowEvent,
  type GenerateResult,
  goto,
  type Message,
  parallel,
  type Step,
  withConversations,
} from "../src/index.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function textResult(text: string): GenerateResult {
  return {
    message: { role: "assistant", content: [{ type: "text", text }] },
    finishReason: "stop",
    usage: emptyUsage(),
    raw: {},
  };
}

function textOf(res: GenerateResult): string {
  const part = res.message.content[0];
  return part?.type === "text" ? part.text : "";
}

function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && m.content[0]?.type === "text") return m.content[0].text;
  }
  return "";
}

// --- runner ----------------------------------------------------------------

test("steps thread state and end when no goto is returned", async () => {
  type S = { log: string[] };
  const flow = createFlow<S>()({ reducers: { log: (c, i) => [...c, ...i] } });
  const b: Step<S> = () => ({ log: ["b"] }); // no goto → ends
  const a: Step<S> = () => goto(b, { log: ["a"] });
  const out = await flow.run(a, { log: [] });
  assert.deepEqual(out.log, ["a", "b"]);
});

test("a step routing to itself forms a bounded loop", async () => {
  type S = { n: number };
  const flow = createFlow<S>()();
  const inc: Step<S> = (s) => (s.n < 3 ? goto(inc, { n: s.n + 1 }) : { n: s.n });
  const out = await flow.run(inc, { n: 0 });
  assert.equal(out.n, 3);
});

test("fan-out runs in parallel and reducers merge the converging join", async () => {
  type S = { sources: string[]; merged?: string };
  const flow = createFlow<S>()({ reducers: { sources: (c, i) => [...c, ...i] } });
  const join: Step<S> = (s) => ({ merged: [...s.sources].sort().join("+") });
  const web: Step<S> = () => goto(join, { sources: ["web"] });
  const docs: Step<S> = () => goto(join, { sources: ["docs"] });
  const plan: Step<S> = () => goto([web, docs]);
  const out = await flow.run(plan, { sources: [] });
  assert.deepEqual([...out.sources].sort(), ["docs", "web"]);
  assert.equal(out.merged, "docs+web"); // join ran once, on merged state
});

test("concurrent writes to a key without a reducer throw", async () => {
  type S = { x?: string };
  const flow = createFlow<S>()();
  const join: Step<S> = () => ({});
  const a: Step<S> = () => goto(join, { x: "a" });
  const b: Step<S> = () => goto(join, { x: "b" });
  const plan: Step<S> = () => goto([a, b]);
  await assert.rejects(() => flow.run(plan, {}), /concurrent writes to "x"/);
});

test("maxSteps guards a non-terminating loop", async () => {
  type S = { n: number };
  const flow = createFlow<S>()({ maxSteps: 5 });
  const inc: Step<S> = (s) => goto(inc, { n: s.n + 1 });
  await assert.rejects(() => flow.run(inc, { n: 0 }), /maxSteps/);
});

// --- parallel() ------------------------------------------------------------

test("parallel preserves order and honors the concurrency limit", async () => {
  let active = 0;
  let peak = 0;
  const out = await parallel(
    [1, 2, 3, 4, 5],
    async (n) => {
      active++;
      peak = Math.max(peak, active);
      await delay(5);
      active--;
      return n * 2;
    },
    { concurrency: 2 },
  );
  assert.deepEqual(out, [2, 4, 6, 8, 10]);
  assert.ok(peak <= 2, `peak ${peak} exceeded concurrency 2`);
});

test("parallel rejects when the signal is already aborted", async () => {
  await assert.rejects(() =>
    parallel([1, 2], async (n) => n, { signal: AbortSignal.abort() }),
  );
});

test("parallel forwards the signal to fn as a third argument", async () => {
  const ac = new AbortController();
  const seen: (AbortSignal | undefined)[] = [];
  await parallel([1, 2], async (_n, _i, signal) => seen.push(signal), {
    signal: ac.signal,
  });
  assert.equal(seen.length, 2);
  assert.ok(seen.every((s) => s === ac.signal));
});

test("a step that throws aborts its still-running siblings via ctx.signal", async () => {
  type S = Record<string, never>;
  const flow = createFlow<S>()();
  let siblingAborted = false;
  const boom: Step<S> = () => {
    throw new Error("boom");
  };
  const slow: Step<S> = async (_s, ctx) => {
    await new Promise<void>((resolve) => {
      ctx.signal?.addEventListener("abort", () => {
        siblingAborted = true;
        resolve();
      });
    });
  };
  const plan: Step<S> = () => goto([boom, slow]);
  await assert.rejects(() => flow.run(plan, {}), /boom/);
  assert.equal(siblingAborted, true);
});

// --- conversation integration ----------------------------------------------

test("fork branches a transcript without affecting the original", async () => {
  const client: ConversationClient = {
    generate: (o) => Promise.resolve(textResult(`reply:${lastUserText(o.messages)}`)),
  };
  const c = new Conversation(client, { model: "test/a" });
  await c.ask("base");
  const f = c.fork();
  await f.ask("branch");
  await c.ask("main");

  assert.equal(c.messages.length, 4);
  assert.equal(f.messages.length, 4);
  assert.equal(lastUserText(c.messages), "main");
  assert.equal(lastUserText(f.messages), "branch");
  assert.equal(c.messages[0]?.content[0]?.type === "text" && c.messages[0].content[0].text, "base");
  assert.equal(f.messages[0]?.content[0]?.type === "text" && f.messages[0].content[0].text, "base");
});

test("withConversations adds ctx.conversation and forwards LLM calls as events", async () => {
  const client: ConversationClient = { generate: () => Promise.resolve(textResult("hi")) };
  const cardanish = {
    conversation: (o: ConstructorParameters<typeof Conversation>[1]) => new Conversation(client, o),
  };

  type S = { reply?: string };
  const events: FlowEvent[] = [];
  const flow = createFlow<S>()({ extendCtx: withConversations(cardanish) });
  const chat: Step<S, ConversationContext> = async (_s, ctx) => {
    const c = ctx.conversation({ model: "test/a", label: "chat" });
    return { reply: textOf(await c.ask("hello")) };
  };

  const out = await flow.run(chat, {}, { onEvent: (e) => events.push(e) });
  assert.equal(out.reply, "hi");
  assert.ok(events.some((e) => e.type === "step:start" && e.name === "chat"));
  assert.ok(events.some((e) => e.type === "step:end"));
  assert.ok(events.some((e) => e.type === "llm" && e.name === "chat"));
});
