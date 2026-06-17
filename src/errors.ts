export type ErrorCode =
  | "auth"
  | "rate_limit"
  | "overloaded"
  | "context_length"
  | "invalid_request"
  | "not_found"
  | "server"
  | "network"
  | "timeout"
  | "aborted"
  | "unknown";

const RETRYABLE: ReadonlySet<ErrorCode> = new Set([
  "rate_limit",
  "overloaded",
  "server",
  "network",
  "timeout",
]);

export interface CardanErrorOptions {
  provider?: string;
  status?: number;
  retryAfterMs?: number;
  /**
   * Absolute time (epoch ms) the rate limit resets, when the provider reports it
   * (e.g. a subscription window reset). Authoritative and exact — consumers
   * should honor it as-is rather than capping it like a relative `retryAfterMs`.
   */
  resetAt?: number;
  raw?: unknown;
  cause?: unknown;
  /** Override the default retryability derived from `code`. */
  retryable?: boolean;
}

export class CardanError extends Error {
  readonly code: ErrorCode;
  readonly provider?: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly resetAt?: number;
  /** Raw provider error body, for debugging. */
  readonly raw?: unknown;

  constructor(code: ErrorCode, message: string, options: CardanErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CardanError";
    this.code = code;
    this.provider = options.provider;
    this.status = options.status;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.retryAfterMs = options.retryAfterMs;
    this.resetAt = options.resetAt;
    this.raw = options.raw;
  }
}

export function isCardanError(error: unknown): error is CardanError {
  return error instanceof CardanError;
}

/** Maps an HTTP status to the default error code. */
export function codeFromStatus(status: number): ErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limit";
  if (status === 529) return "overloaded";
  if (status >= 500) return "server";
  if (status >= 400) return "invalid_request";
  return "unknown";
}

/** Parses a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** Wraps fetch/abort failures into CardanError. */
export function wrapFetchError(error: unknown, provider: string): CardanError {
  if (isCardanError(error)) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new CardanError("aborted", "request aborted", { provider, cause: error });
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new CardanError("aborted", "request aborted", { provider, cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CardanError("network", `network error: ${message}`, {
    provider,
    cause: error,
  });
}
