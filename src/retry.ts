import { CardanError, isCardanError } from "./errors.js";
import { DEFAULT_RETRY, type RetryOptions } from "./types.js";

export function resolveRetry(
  retry: Partial<RetryOptions> | false | undefined,
): RetryOptions {
  if (retry === false) return { ...DEFAULT_RETRY, maxRetries: 0 };
  return { ...DEFAULT_RETRY, ...retry };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
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
      // jittered backoff is capped by maxDelayMs; an explicit Retry-After is
      // authoritative and honored as-is (the caller's signal bounds it).
      const backoff = Math.min(
        options.initialDelayMs * 2 ** attempt,
        options.maxDelayMs,
      );
      const wait = error.retryAfterMs ?? Math.random() * backoff;
      await delay(wait, signal);
      attempt++;
    }
  }
}
