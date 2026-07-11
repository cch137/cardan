import { CardanError, isCardanError } from "./errors.js";
import { DEFAULT_RETRY, type RetryOptions } from "./types.js";

export function resolveRetry(
  retry: Partial<RetryOptions> | false | undefined,
): RetryOptions {
  if (retry === false) return { ...DEFAULT_RETRY, maxRetries: 0 };
  return { ...DEFAULT_RETRY, ...retry };
}

/** Resolves the effective per-attempt timeout; `<= 0`/undefined means none. */
export function resolveTimeout(
  perCall: number | undefined,
  providerDefault: number | undefined,
): number | undefined {
  const t = perCall ?? providerDefault;
  return t && t > 0 ? t : undefined;
}

/**
 * Composes the caller's `signal` with a per-attempt timeout into one signal for
 * `fetch`. The timeout aborts with a `CardanError("timeout")` (retryable), while
 * a caller abort propagates its own reason (staying `aborted`, not retryable);
 * because `fetch` rejects with `signal.reason`, that error surfaces verbatim.
 * The caller MUST invoke `clear()` in a `finally` to cancel the timer and detach
 * the listener — a pending timer would otherwise keep the event loop alive.
 */
export function withTimeoutSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal: AbortSignal | undefined; clear: () => void } {
  if (!timeoutMs || timeoutMs <= 0) return { signal, clear: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new CardanError("timeout", `request timed out after ${timeoutMs}ms`),
    );
  }, timeoutMs);
  const onAbort = () => controller.abort(signal!.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const clear = (): void => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  };
  return { signal: controller.signal, clear };
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CardanError("aborted", "request aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new CardanError("aborted", "request aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs `fn`, retrying CardanErrors marked retryable with exponential backoff
 * (full jitter), honoring `retryAfterMs` from the provider when present.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
  signal?: AbortSignal,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (!isCardanError(error) || !error.retryable || attempt >= options.maxRetries) {
        throw error;
      }
      // Cap every wait at maxDelayMs. A multi-hour subscription Retry-After
      // must not hang the request; long cooldowns belong to the pool, not
      // withRetry. Caller's `signal` still bounds the overall attempt.
      const backoff = Math.min(
        options.initialDelayMs * 2 ** attempt,
        options.maxDelayMs,
      );
      const wait = Math.min(
        error.retryAfterMs ?? Math.random() * backoff,
        options.maxDelayMs,
      );
      await delay(wait, signal);
      attempt++;
    }
  }
}
