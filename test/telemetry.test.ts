import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CardanError,
  createCardan,
  emptyUsage,
  type GenerateOptions,
  type GenerateResult,
  type Provider,
  type StreamEvent,
  type TelemetryEvent,
  type Usage,
} from "../src/index.js";

function result(usage?: Usage): GenerateResult {
  return {
    message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    text: "ok",
    finishReason: "stop",
    usage: usage ?? emptyUsage(),
    raw: {},
  };
}

const usageSample: Usage = {
  input: { total: 10, details: {} },
  output: { total: 5, details: { reasoning: 2 } },
};

/** Scriptable provider for Cardan routing tests. */
class Fake implements Provider {
  readonly name = "fake";
  fail: CardanError | Error | null = null;
  streamFail: CardanError | Error | null = null;
  streamUsage: Usage = usageSample;
  /** When true, stream yields text then throws before finish. */
  throwMidStream = false;

  async generate(_options: GenerateOptions): Promise<GenerateResult> {
    if (this.fail) throw this.fail;
    return result(usageSample);
  }

  async *stream(_options: GenerateOptions): AsyncIterable<StreamEvent> {
    if (this.streamFail) throw this.streamFail;
    yield { type: "text_delta", text: "hi" };
    if (this.throwMidStream) {
      throw new CardanError("server", "mid-stream boom", { status: 500 });
    }
    yield { type: "finish", reason: "stop", usage: this.streamUsage };
  }

  async embed() {
    if (this.fail) throw this.fail;
    return { embeddings: [[0.1]], usage: emptyUsage(), raw: {} };
  }
}

const gen = {
  model: "fake/my-model" as const,
  messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
};

function collectEvents(): {
  events: TelemetryEvent[];
  onRequest: (e: TelemetryEvent) => void;
} {
  const events: TelemetryEvent[] = [];
  return { events, onRequest: (e) => events.push(e) };
}

test("generate ok emits usage once", async () => {
  const fake = new Fake();
  const { events, onRequest } = collectEvents();
  const cardan = createCardan({
    providers: { fake },
    telemetry: { onRequest },
  });

  const res = await cardan.generate(gen);
  assert.equal(res.text, "ok");
  assert.equal(events.length, 1);
  const e = events[0]!;
  assert.equal(e.provider, "fake");
  assert.equal(e.model, "my-model");
  assert.equal(e.op, "generate");
  assert.equal(e.ok, true);
  assert.ok(e.durationMs >= 0);
  assert.deepEqual(e.usage, usageSample);
  assert.equal(e.errorCode, undefined);
});

test("generate error carries errorCode and rethrows", async () => {
  const fake = new Fake();
  fake.fail = new CardanError("rate_limit", "limited", {
    status: 429,
    retryAfterMs: 1000,
    resetAt: 1_700_000_000_000,
  });
  const { events, onRequest } = collectEvents();
  const cardan = createCardan({
    providers: { fake },
    telemetry: { onRequest },
  });

  await assert.rejects(cardan.generate(gen), /limited/);
  assert.equal(events.length, 1);
  const e = events[0]!;
  assert.equal(e.ok, false);
  assert.equal(e.op, "generate");
  assert.equal(e.errorCode, "rate_limit");
  assert.equal(e.status, 429);
  assert.equal(e.retryAfterMs, 1000);
  assert.equal(e.resetAt, 1_700_000_000_000);
  assert.equal(e.usage, undefined);
});

test("generate non-cardan error uses errorCode unknown", async () => {
  const fake = new Fake();
  fake.fail = new Error("boom");
  const { events, onRequest } = collectEvents();
  const cardan = createCardan({
    providers: { fake },
    telemetry: { onRequest },
  });

  await assert.rejects(cardan.generate(gen), /boom/);
  assert.equal(events[0]!.errorCode, "unknown");
  assert.equal(events[0]!.ok, false);
});

test("stream ok captures finish usage", async () => {
  const fake = new Fake();
  const { events, onRequest } = collectEvents();
  const cardan = createCardan({
    providers: { fake },
    telemetry: { onRequest },
  });

  const seen: StreamEvent[] = [];
  for await (const event of cardan.stream(gen)) seen.push(event);

  assert.equal(seen.length, 2);
  assert.equal(seen[1]!.type, "finish");
  assert.equal(events.length, 1);
  const e = events[0]!;
  assert.equal(e.op, "stream");
  assert.equal(e.ok, true);
  assert.deepEqual(e.usage, usageSample);
  assert.equal(e.provider, "fake");
  assert.equal(e.model, "my-model");
});

test("stream error emits ok:false and rethrows", async () => {
  const fake = new Fake();
  fake.throwMidStream = true;
  const { events, onRequest } = collectEvents();
  const cardan = createCardan({
    providers: { fake },
    telemetry: { onRequest },
  });

  await assert.rejects(async () => {
    for await (const _ of cardan.stream(gen)) {
      /* drain */
    }
  }, /mid-stream boom/);

  assert.equal(events.length, 1);
  const e = events[0]!;
  assert.equal(e.ok, false);
  assert.equal(e.op, "stream");
  assert.equal(e.errorCode, "server");
  assert.equal(e.status, 500);
  assert.equal(e.usage, undefined);
});

test("stream abandon before finish emits ok:true without usage", async () => {
  const fake = new Fake();
  const { events, onRequest } = collectEvents();
  const cardan = createCardan({
    providers: { fake },
    telemetry: { onRequest },
  });

  const it = cardan.stream(gen)[Symbol.asyncIterator]();
  const first = await it.next();
  assert.equal(first.value?.type, "text_delta");
  // abandon without consuming finish
  await it.return?.();

  assert.equal(events.length, 1);
  const e = events[0]!;
  assert.equal(e.ok, true);
  assert.equal(e.op, "stream");
  assert.equal(e.usage, undefined);
});

test("embed ok omits usage", async () => {
  const fake = new Fake();
  const { events, onRequest } = collectEvents();
  const cardan = createCardan({
    providers: { fake },
    telemetry: { onRequest },
  });

  await cardan.embed({ model: "fake/embed-1", input: ["hi"] });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.op, "embed");
  assert.equal(events[0]!.ok, true);
  assert.equal(events[0]!.usage, undefined);
});

test("absent telemetry config does not crash", async () => {
  const fake = new Fake();
  const cardan = createCardan({ providers: { fake } });
  const res = await cardan.generate(gen);
  assert.equal(res.text, "ok");
  const events: StreamEvent[] = [];
  for await (const e of cardan.stream(gen)) events.push(e);
  assert.equal(events.length, 2);
  await cardan.embed({ model: "fake/embed-1", input: ["hi"] });
});

test("broken onRequest does not affect the request", async () => {
  const fake = new Fake();
  const cardan = createCardan({
    providers: { fake },
    telemetry: {
      onRequest() {
        throw new Error("observer broken");
      },
    },
  });
  const res = await cardan.generate(gen);
  assert.equal(res.text, "ok");
});
