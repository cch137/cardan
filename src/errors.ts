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

/** Message + code pulled from a provider wire error payload. */
export interface ExtractedProviderError {
  code: ErrorCode;
  message: string;
  /** Provider's original type/code string when present. */
  type?: string;
}

/**
 * Maps a provider's error type/code string (Anthropic `error.type`, OpenAI
 * `error.code` / event `code`, etc.) onto a cardan {@link ErrorCode}.
 */
export function codeFromProviderType(type: string | undefined): ErrorCode | undefined {
  if (!type) return undefined;
  const t = type.toLowerCase();
  if (
    t === "rate_limit_error" ||
    t === "rate_limit_exceeded" ||
    t.includes("rate_limit")
  ) {
    return "rate_limit";
  }
  if (t === "overloaded_error" || t === "overloaded") return "overloaded";
  if (
    t === "authentication_error" ||
    t === "permission_error" ||
    t === "auth_error" ||
    t === "invalid_api_key"
  ) {
    return "auth";
  }
  if (t === "not_found_error" || t === "not_found") return "not_found";
  if (
    t === "invalid_request_error" ||
    t === "invalid_request" ||
    t === "invalid_value"
  ) {
    return "invalid_request";
  }
  if (
    t === "server_error" ||
    t === "api_error" ||
    t === "internal_server_error"
  ) {
    return "server";
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function strField(
  obj: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const v = obj?.[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}

/**
 * Pull message + {@link ErrorCode} from common provider wire shapes:
 * - `{ error: { type?, code?, message? } }` (Anthropic, many OpenAI-like)
 * - `{ type: "error", error: { … } }` (nested stream error)
 * - `{ type: "error", message, code }` (OpenAI Responses SSE `error`)
 * - bare `{ message, type/code }` or a string
 *
 * Never returns a bare `"stream error"` when a type/code is available — the
 * fallback is `stream error (<type>)` so callers can still diagnose.
 */
export function extractProviderError(raw: unknown): ExtractedProviderError {
  if (typeof raw === "string" && raw.trim()) {
    return { code: "unknown", message: raw.trim() };
  }

  const root = asRecord(raw);
  // Prefer nested `error` object when present (Anthropic stream, response.failed, …)
  const nested = asRecord(root?.error);
  const type =
    strField(nested, "type") ??
    strField(nested, "code") ??
    strField(root, "type") ??
    strField(root, "code");
  // OpenAI Responses top-level `type` is often the event name `"error"` — not
  // useful as an error class. Prefer nested type/code; fall back to top-level
  // only when it isn't the event discriminator.
  const typeForCode =
    strField(nested, "type") ??
    strField(nested, "code") ??
    (strField(root, "type") !== "error" ? strField(root, "type") : undefined) ??
    strField(root, "code");

  let message =
    strField(nested, "message") ??
    strField(root, "message") ??
    (typeof nested === "object" && nested && typeof nested.error === "string"
      ? nested.error
      : undefined);

  if (message && /context (window|length)|too many tokens|prompt is too long/i.test(message)) {
    return { code: "context_length", message, type: typeForCode ?? type };
  }

  const code = codeFromProviderType(typeForCode) ?? "server";

  if (!message) {
    message = typeForCode
      ? `stream error (${typeForCode})`
      : "stream error";
  }

  return { code, message, type: typeForCode ?? type };
}

/**
 * Build a non-retryable stream {@link CardanError} from a provider event/chunk.
 * Adapters pass the raw SSE payload (or its `error` field) so the message and
 * code come from the wire rather than a generic `"stream error"`.
 */
export function streamCardanError(
  raw: unknown,
  provider: string,
  options: { retryable?: boolean } = {},
): CardanError {
  const extracted = extractProviderError(raw);
  return new CardanError(extracted.code, extracted.message, {
    provider,
    raw,
    retryable: options.retryable ?? false,
  });
}
