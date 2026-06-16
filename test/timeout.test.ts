import { test } from "node:test";
import assert from "node:assert/strict";

import { AnthropicProvider } from "../src/providers/anthropic.js";
import { isCardanError, textMessage } from "../src/index.js";

// Timeout is implemented once in retry.ts (resolveTimeout + withTimeoutSignal)
// and wired identically into every provider's request(). These tests drive it
// end-to-end through AnthropicProvider; the other adapters share the same
// helper and wiring (covered by typecheck).

const FIXTURE = {
  content: [{ type: "text", text: "hi" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A fetch that never resolves on its own but rejects with `signal.reason` when
 * aborted — mirroring undici/Deno, where an aborted fetch rejects with exactly
 * the reason passed to `controller.abort(reason)`. `onCall` observes each call.
 */
function hangingFetch(onCall?: () => void): typeof globalThis.fetch {
  return ((_input, init) => {
    onCall?.();
    const signal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  }) as typeof globalThis.fetch;
}

test("timeoutMs aborts a hung request with a retryable timeout error", async () => {
  const provider = new AnthropicProvider({
    apiKey: "sk",
    fetch: hangingFetch(),
    retry: false,
  });
  await assert.rejects(
    provider.generate({
      model: "claude-opus-4-8",
      messages: [textMessage("user", "hi")],
      timeoutMs: 20,
    }),
    (err: unknown) =>
      isCardanError(err) && err.code === "timeout" && err.retryable === true,
  );
});

test("a caller abort surfaces as aborted, not timeout", async () => {
  const controller = new AbortController();
  const provider = new AnthropicProvider({
    apiKey: "sk",
    fetch: hangingFetch(),
    retry: false,
  });
  const promise = provider.generate({
    model: "claude-opus-4-8",
    messages: [textMessage("user", "hi")],
    signal: controller.signal,
    timeoutMs: 10_000, // long, so the caller abort wins the race
  });
  controller.abort();
  await assert.rejects(
    promise,
    (err: unknown) => isCardanError(err) && err.code === "aborted",
  );
});

test("a timeout is retried (provider-level default applies)", async () => {
  let calls = 0;
  const provider = new AnthropicProvider({
    apiKey: "sk",
    fetch: hangingFetch(() => {
      calls++;
    }),
    retry: { maxRetries: 2, initialDelayMs: 1 },
    timeoutMs: 15,
  });
  await assert.rejects(
    provider.generate({
      model: "claude-opus-4-8",
      messages: [textMessage("user", "hi")],
    }),
    (err: unknown) => isCardanError(err) && err.code === "timeout",
  );
  assert.equal(calls, 3); // initial attempt + 2 retries
});

test("per-request timeoutMs overrides the provider default", async () => {
  const provider = new AnthropicProvider({
    apiKey: "sk",
    fetch: hangingFetch(),
    retry: false,
    timeoutMs: 10_000, // provider default would not fire during the test
  });
  await assert.rejects(
    provider.generate({
      model: "claude-opus-4-8",
      messages: [textMessage("user", "hi")],
      timeoutMs: 20, // per-call override fires
    }),
    (err: unknown) => isCardanError(err) && err.code === "timeout",
  );
});

test("no timeout by default: a slow request still completes", async () => {
  const slowFetch = (() =>
    new Promise<Response>((resolve) =>
      setTimeout(() => resolve(jsonResponse(FIXTURE)), 30),
    )) as typeof globalThis.fetch;
  const provider = new AnthropicProvider({ apiKey: "sk", fetch: slowFetch });
  const result = await provider.generate({
    model: "claude-opus-4-8",
    messages: [textMessage("user", "hi")],
  });
  assert.equal(result.finishReason, "stop");
});
