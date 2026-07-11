import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CardanError,
  createPool,
  emptyUsage,
  type GenerateOptions,
  type GenerateResult,
  type Provider,
  type StreamEvent,
} from "../src/index.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function result(text = "ok"): GenerateResult {
  return {
    message: { role: "assistant", content: [{ type: "text", text }] },
    text,
    finishReason: "stop",
    usage: emptyUsage(),
    raw: {},
  };
}

const rateLimit = (retryAfterMs?: number) =>
  new CardanError("rate_limit", "limited", { retryAfterMs });

/** A scriptable provider. `fail(model)` returns an error to throw, or null. */
class Fake implements Provider {
  readonly name = "fake";
  attempts = 0;
  served = 0;
  fail: (model: string) => CardanError | null = () => null;

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    this.attempts++;
    const err = this.fail(options.model);
    if (err) throw err;
    this.served++;
    return result();
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamEvent> {
    this.attempts++;
    const err = this.fail(options.model);
    if (err) throw err;
    this.served++;
    yield { type: "text_delta", text: "hi" };
    yield { type: "finish", reason: "stop", usage: emptyUsage() };
  }
}

/** A usage-aware provider whose `cooldownUntil` the pool will probe. */
const gen = (model: string): GenerateOptions => ({
  model,
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
});

const silent = { onFailover: () => {} };

test("pool: round-robins ready members", async () => {
  const a = new Fake();
  const b = new Fake();
  const pool = createPool({ members: [{ provider: a }, { provider: b }] });
  for (let i = 0; i < 4; i++) await pool.generate(gen("m"));
  assert.equal(a.served, 2);
  assert.equal(b.served, 2);
});

test("pool: accepts bare providers and PoolMember entries interchangeably", async () => {
  const a = new Fake();
  const b = new Fake();
  const c = new Fake();
  // a/b are bare providers; c is a full member with weight + label
  const pool = createPool({
    members: [a, b, { provider: c, weight: 2, label: "c" }],
  });
  // rotation [a, b, c, c] → 8 requests serve a:2, b:2, c:4
  for (let i = 0; i < 8; i++) await pool.generate(gen("m"));
  assert.equal(a.served, 2);
  assert.equal(b.served, 2);
  assert.equal(c.served, 4);
});

test("pool: fails over on a failover-class error", async () => {
  const a = new Fake();
  a.fail = () => rateLimit();
  const b = new Fake();
  const pool = createPool({ members: [{ provider: a }, { provider: b }], ...silent });
  const res = await pool.generate(gen("m"));
  assert.equal(res.text, "ok");
  assert.equal(b.served, 1);
});

test("pool: surfaces a non-failover error without switching", async () => {
  const a = new Fake();
  a.fail = () => new CardanError("invalid_request", "bad");
  const b = new Fake();
  const pool = createPool({ members: [{ provider: a }, { provider: b }], ...silent });
  await assert.rejects(pool.generate(gen("m")), /bad/);
  assert.equal(b.attempts, 0);
});

test("pool: cools a member per model and keeps it for other models", async () => {
  const a = new Fake();
  a.fail = (model) => (model === "m1" ? rateLimit(60_000) : null);
  const b = new Fake();
  const pool = createPool({ members: [{ provider: a }, { provider: b }], ...silent });

  for (let i = 0; i < 6; i++) await pool.generate(gen("m1"));
  // a is attempted once (the failure that set the cooldown), then always skipped
  assert.equal(a.attempts, 1);
  assert.equal(a.served, 0);
  assert.equal(b.served, 6);

  // a different model is unaffected by m1's cooldown
  await pool.generate(gen("m2"));
  assert.equal(a.served, 1);
});

test("pool: thaws a member after its cooldown expires", async () => {
  const a = new Fake();
  let first = true;
  a.fail = (model) => {
    if (model === "m1" && first) {
      first = false;
      return rateLimit(40);
    }
    return null;
  };
  const b = new Fake();
  b.fail = () => rateLimit(); // never cooled (no retry-after), always fails over
  const pool = createPool({ members: [{ provider: a }, { provider: b }], ...silent });

  await assert.rejects(pool.generate(gen("m1"))); // both fail on the first round
  await delay(60);
  const res = await pool.generate(gen("m1")); // a has thawed and now succeeds
  assert.equal(res.text, "ok");
  assert.equal(a.served, 1);
});

test("pool: throws a clear error when all members are cooling", async () => {
  const a = new Fake();
  const b = new Fake();
  a.fail = () => rateLimit(300_000);
  b.fail = () => rateLimit(300_000);
  const pool = createPool({ members: [{ provider: a }, { provider: b }], ...silent });

  await assert.rejects(pool.generate(gen("m1"))); // sets both cooldowns
  await assert.rejects(pool.generate(gen("m1")), (err: unknown) => {
    assert.ok(err instanceof CardanError);
    assert.equal(err.code, "rate_limit");
    assert.match(err.message, /all 2 members are cooling down for model "m1"/);
    assert.ok(err.retryAfterMs! > 0 && err.retryAfterMs! <= 15 * 60 * 1000);
    return true;
  });
});

test("pool: all-cooling last-ditch forces retry:false (no Retry-After hang)", async () => {
  /** Records the `retry` option the pool passed through. */
  class SpyFake extends Fake {
    lastRetry: GenerateOptions["retry"];
    override async generate(options: GenerateOptions): Promise<GenerateResult> {
      this.lastRetry = options.retry;
      return super.generate(options);
    }
  }
  const a = new SpyFake();
  const b = new SpyFake();
  a.fail = () => rateLimit(300_000);
  b.fail = () => rateLimit(300_000);
  const pool = createPool({ members: [{ provider: a }, { provider: b }], ...silent });

  await assert.rejects(pool.generate(gen("m1"))); // both cooling
  // Last-ditch: only one attempt, but must still disable per-attempt retry.
  await assert.rejects(pool.generate(gen("m1")));
  const ditched = a.lastRetry === false || b.lastRetry === false;
  assert.equal(ditched, true);
});

test("pool: caps a retry-after cooldown at maxCooldownMs", async () => {
  const a = new Fake();
  a.fail = () => rateLimit(60 * 60 * 1000); // 1 hour
  const pool = createPool({
    members: [{ provider: a }],
    maxCooldownMs: 1000,
    ...silent,
  });
  await assert.rejects(pool.generate(gen("m1"))); // sets cooldown (capped)
  await assert.rejects(pool.generate(gen("m1")), (err: unknown) => {
    assert.ok(err instanceof CardanError);
    assert.ok(err.retryAfterMs! <= 1000); // not the 1-hour the header asked for
    return true;
  });
});

test("pool: an absolute resetAt cooldown is exact and never capped", async () => {
  const reset = Date.now() + 60 * 60 * 1000; // 1 hour out
  const a = new Fake();
  // resetAt present (and a small retryAfterMs that must be ignored in its favor)
  a.fail = () => new CardanError("rate_limit", "limited", { resetAt: reset, retryAfterMs: 500 });
  const pool = createPool({ members: [a], maxCooldownMs: 1000, ...silent });

  await assert.rejects(pool.generate(gen("m1"))); // sets cooldown to the exact reset
  await assert.rejects(pool.generate(gen("m1")), (err: unknown) => {
    assert.ok(err instanceof CardanError);
    // ~1h remaining: resetAt wins over retryAfterMs and is not capped to maxCooldownMs
    assert.ok(err.retryAfterMs! > 60 * 60 * 1000 - 5000);
    return true;
  });
});

test("pool: an absolute resetAt cools the whole member across models", async () => {
  const reset = Date.now() + 60 * 60 * 1000; // 1 hour out
  const a = new Fake();
  // account-wide reset signal raised while serving m1
  a.fail = (model) =>
    model === "m1" ? new CardanError("rate_limit", "limited", { resetAt: reset }) : null;
  const b = new Fake();
  const pool = createPool({ members: [a, b], ...silent });

  await pool.generate(gen("m1")); // a fails (resetAt) → fails over to b
  // a is now cooled account-wide, so even a *different* model skips it
  await pool.generate(gen("m2"));
  await pool.generate(gen("m2"));
  assert.equal(a.served, 0); // never served while the account is cooled
  assert.equal(b.served, 3);
});

test("pool: fails over on stream before the first event", async () => {
  const a = new Fake();
  a.fail = () => rateLimit();
  const b = new Fake();
  const pool = createPool({ members: [{ provider: a }, { provider: b }], ...silent });

  const events: StreamEvent[] = [];
  for await (const event of pool.stream(gen("m"))) events.push(event);
  assert.equal(b.served, 1);
  assert.equal(events[0]?.type, "text_delta");
});
