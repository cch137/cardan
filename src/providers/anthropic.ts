import {
  CardanError,
  codeFromStatus,
  parseRetryAfter,
  wrapFetchError,
  type ErrorCode,
} from "../errors.js";
import { readEnv, warnOnce } from "../env.js";
import { normalizeMessages, partsToText, splitLeadingSystem } from "../normalize.js";
import { parseSse } from "../sse.js";
import { resolveRetry, resolveTimeout, withRetry, withTimeoutSignal } from "../retry.js";
import { toJsonSchema } from "../schema.js";
import {
  addCitations,
  bytesToBase64,
  normalizeWebSearch,
  parseStructuredOutput,
  parseToolArgs,
} from "../util.js";
import {
  addUsage,
  emptyUsage,
  type ContentPart,
  type FinishReason,
  type GenerateOptions,
  type GenerateResult,
  type Message,
  type Provider,
  type RateLimitStatus,
  type RateLimitWindow,
  type ReasoningEffort,
  type RetryOptions,
  type StreamEvent,
  type Usage,
  type WebCitation,
  type WebSearchOptions,
} from "../types.js";

/** Known Anthropic model ids — literal-only, drives editor autocomplete. */
export type AnthropicModelId =
  | "claude-fable-5"
  | "claude-opus-4-8"
  | "claude-sonnet-5"
  | "claude-haiku-4-5";

export type AnthropicModel = AnthropicModelId | (string & {});

/**
 * A Claude.ai subscription OAuth credential set, as stored by the Claude CLI in
 * `~/.claude/.credentials.json` (`claudeAiOauth`).
 */
export interface OAuthCredentials {
  /** Short-lived bearer token sent to the Messages API. */
  accessToken: string;
  /**
   * Mints new access tokens; rotates on every refresh. Absent for inference-only
   * tokens (e.g. `claude setup-token`), which are long-lived and not refreshable.
   */
  refreshToken?: string | null;
  /** Epoch ms. Absent means unknown — no proactive refresh, refresh on 401 only. */
  expiresAt?: number | null;
  scopes?: string[];
}

/** Authenticate with a Claude.ai subscription token instead of an API key. */
export interface AnthropicOAuthOptions {
  credentials: OAuthCredentials;
  /**
   * Called after each successful refresh with the rotated credentials. Persist
   * them — the previous refresh token stops working once a new one is issued.
   */
  onRefresh?: (credentials: Required<OAuthCredentials>) => void | Promise<void>;
  /** Override the OAuth token endpoint. */
  tokenUrl?: string;
  /** Override the OAuth client id. */
  clientId?: string;
  /** Scopes requested on refresh. */
  refreshScopes?: string[];
  /** Override the system identity prefix the subscription grant expects. */
  identity?: string;
}

/**
 * Experimental, unsupported knobs for local debugging only. Not covered by
 * semver — any of these may change behavior or be removed without notice, and
 * they are intentionally undocumented for normal use. Do not ship them.
 */
export interface AnthropicExperimentalOptions {
  /**
   * Skip injecting the mandatory Claude Code identity system block in OAuth
   * (subscription) mode. That block is normally *required* for the subscription
   * grant to be accepted, so enabling this will most likely make the API reject
   * the request — it exists only to probe what happens when the identity is
   * withheld. No effect in API-key mode.
   */
  omitOAuthIdentity?: boolean;
}

export interface AnthropicProviderOptions {
  /** Defaults to the `ANTHROPIC_API_KEY` environment variable. */
  apiKey?: string;
  /**
   * Authenticate with a Claude.ai subscription OAuth token (Pro/Max/Team/
   * Enterprise) instead of an API key, so requests bill against the subscription
   * rather than pay-per-token API credits. Mutually exclusive with `apiKey`
   * (takes precedence). Bearer auth, the `oauth-2025-04-20` beta, and the
   * required Claude Code identity system block are all applied automatically.
   *
   * Pass a bare token string as shorthand for `{ credentials: { accessToken } }`
   * — handy for a `claude setup-token` token; use the object form when you need
   * a refresh token, `onRefresh`, etc.
   */
  oauth?: string | AnthropicOAuthOptions;
  /** Defaults to `https://api.anthropic.com`. */
  baseUrl?: string;
  /** `anthropic-version` header. Defaults to `2023-06-01`. */
  version?: string;
  /** Extra headers on every request (e.g. `anthropic-beta`). */
  headers?: Record<string, string>;
  /** Custom fetch implementation (testing, proxies). */
  fetch?: typeof globalThis.fetch;
  /** Default retry behavior for all requests; `false` disables. */
  retry?: Partial<RetryOptions> | false;
  /** Default per-attempt timeout (ms) for all requests; `0`/undefined disables. */
  timeoutMs?: number;
  /**
   * Experimental debugging knobs. Unsupported and not for normal use — see
   * {@link AnthropicExperimentalOptions}.
   */
  experimental?: AnthropicExperimentalOptions;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_VERSION = "2023-06-01";
const DEFAULT_MAX_OUTPUT_TOKENS = 16000;

// OAuth (Claude.ai subscription) auth. A subscription token is only accepted on
// /v1/messages when the request looks like Claude Code — all three are required:
//   (1) Bearer auth (not x-api-key),
//   (2) the oauth-2025-04-20 beta flag,
//   (3) the identity string as the first system block.
// The client id below is the Claude CLI's, used for the refresh-token grant.
const OAUTH_BETA = "oauth-2025-04-20";
const OAUTH_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_REFRESH_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];
const OAUTH_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Manages a Claude.ai subscription OAuth credential for the Messages API.
 *
 * Token lifetime:
 * - The access token has a fixed lifetime (`expiresAt`, typically a few hours).
 *   Using it does not extend it.
 * - The refresh token mints new access tokens and itself rotates on every
 *   refresh — the previous one stops working, so the new credentials must be
 *   persisted (via `onRefresh`) or the next refresh fails.
 * - Tokens refresh proactively ~5 min before expiry; concurrent callers share a
 *   single refresh round-trip; a 401/403 forces one refresh + retry (covers a
 *   clock-skew or server-revoked token the local expiry check thought was fine).
 * - Inference-only tokens (e.g. `claude setup-token`) carry no refresh token;
 *   they are long-lived and used as-is, surfacing an `auth` error once expired.
 *
 * Secrecy: the access token is only ever sent as `Authorization: Bearer` to the
 * Messages API; the refresh token only to the OAuth token endpoint. Neither is
 * placed in thrown errors.
 */
class ClaudeOAuthAuth {
  private creds: OAuthCredentials;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly opts: AnthropicOAuthOptions,
    private readonly fetchImpl: typeof globalThis.fetch,
  ) {
    if (!opts.credentials?.accessToken) {
      throw new CardanError("auth", "oauth.credentials.accessToken is required", {
        provider: "anthropic",
      });
    }
    this.creds = { ...opts.credentials };
  }

  get identity(): string {
    return this.opts.identity ?? OAUTH_IDENTITY;
  }

  get canRefresh(): boolean {
    return Boolean(this.creds.refreshToken);
  }

  private get expired(): boolean {
    const e = this.creds.expiresAt;
    return e != null && Date.now() + OAUTH_EXPIRY_BUFFER_MS >= e;
  }

  /** Valid access token, refreshing first if it is near expiry and refreshable. */
  async accessToken(): Promise<string> {
    if (this.expired && this.canRefresh) await this.refresh();
    return this.creds.accessToken;
  }

  /** Force a refresh now; concurrent callers share one round-trip. */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doRefresh(): Promise<void> {
    const refreshToken = this.creds.refreshToken;
    if (!refreshToken) {
      throw new CardanError("auth", "cannot refresh OAuth token: no refresh token", {
        provider: "anthropic",
      });
    }
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.tokenUrl ?? OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: this.opts.clientId ?? OAUTH_CLIENT_ID,
          scope: (this.opts.refreshScopes ?? OAUTH_REFRESH_SCOPES).join(" "),
        }),
      });
    } catch (error) {
      throw wrapFetchError(error, "anthropic");
    }
    if (!res.ok) {
      throw new CardanError("auth", `OAuth token refresh failed (HTTP ${res.status})`, {
        provider: "anthropic",
        status: res.status,
      });
    }
    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    const next: Required<OAuthCredentials> = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt:
        typeof data.expires_in === "number"
          ? Date.now() + data.expires_in * 1000
          : null,
      scopes: data.scope
        ? data.scope.split(" ").filter(Boolean)
        : (this.creds.scopes ?? []),
    };
    this.creds = next;
    await this.opts.onRefresh?.(next);
  }
}

/** A rate-limit header carrying epoch *seconds*, converted to epoch ms, or `undefined`. */
function resetHeaderMs(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

/** A rate-limit header carrying a number (e.g. utilization 0..1), or `undefined`. */
function numHeader(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The representative subscription-window reset (epoch ms) from the unified
 * rate-limit response headers, or `undefined`. These headers ride on every
 * Messages API response (including the 429), so they work for any OAuth token —
 * including an inference-only `claude setup-token` — without the `user:profile`
 * scope the `/api/oauth/usage` endpoint demands.
 */
function unifiedResetMs(headers: Headers): number | undefined {
  return resetHeaderMs(headers, "anthropic-ratelimit-unified-reset");
}

/**
 * One unified window (`5h` / `7d`) from the rate-limit headers, if any field is
 * present. Anthropic always sends the three fields together, so a partial window
 * is not expected; if it ever happens, a missing field coalesces to a neutral
 * default (`utilization: 0` reads as "unknown / not constrained", `resetAt: 0`).
 */
function parseWindow(headers: Headers, prefix: string): RateLimitWindow | undefined {
  const utilization = numHeader(headers, `anthropic-ratelimit-unified-${prefix}-utilization`);
  const resetAt = resetHeaderMs(headers, `anthropic-ratelimit-unified-${prefix}-reset`);
  const status = headers.get(`anthropic-ratelimit-unified-${prefix}-status`) ?? undefined;
  if (utilization === undefined && resetAt === undefined && status === undefined) {
    return undefined;
  }
  return { utilization: utilization ?? 0, resetAt: resetAt ?? 0, status: status ?? "" };
}

/**
 * The subscription rate-limit snapshot from a response's unified headers, or
 * `undefined` if none are present (e.g. API-key requests don't carry them).
 * Present on every response, so callers/pools can react before a 429.
 */
function parseRateLimit(headers: Headers): RateLimitStatus | undefined {
  const representative =
    headers.get("anthropic-ratelimit-unified-representative-claim") ?? undefined;
  const status = headers.get("anthropic-ratelimit-unified-status") ?? undefined;
  const resetAt = unifiedResetMs(headers);
  const fiveHour = parseWindow(headers, "5h");
  const sevenDay = parseWindow(headers, "7d");
  if (
    representative === undefined &&
    status === undefined &&
    resetAt === undefined &&
    !fiveHour &&
    !sevenDay
  ) {
    return undefined;
  }
  const out: RateLimitStatus = {};
  if (representative !== undefined) out.representative = representative;
  if (status !== undefined) out.status = status;
  if (resetAt !== undefined) out.resetAt = resetAt;
  if (fiveHour) out.fiveHour = fiveHour;
  if (sevenDay) out.sevenDay = sevenDay;
  return out;
}

/**
 * The `cache_control` marker for an enabled {@link GenerateOptions.cache}, or
 * `null` when caching is off. `ttl: "1h"` selects the longer-lived (and
 * costlier to write) breakpoint; the default is the 5-minute ephemeral cache.
 */
function resolveCacheControl(
  cache: GenerateOptions["cache"],
): { type: "ephemeral"; ttl?: "1h" } | null {
  if (!cache) return null;
  const ttl = typeof cache === "object" ? cache.ttl : undefined;
  return ttl === "1h"
    ? { type: "ephemeral", ttl: "1h" }
    : { type: "ephemeral" };
}

/** Returns a comma-joined beta header that includes `flag` exactly once. */
function withBeta(existing: string | undefined, flag: string): string {
  if (!existing) return flag;
  const parts = existing.split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.includes(flag)) parts.push(flag);
  return parts.join(",");
}

/**
 * Models that reject sampling params (`temperature`, `top_p`) with a 400, so the
 * adapter drops them rather than fail. A coarse `claude-<name>-<major>(-<minor>)?`
 * gate by family that matches every version of the reasoning lines (fable,
 * mythos, sonnet, opus), so new releases need no edit. Haiku is excluded — its
 * current line still accepts sampling. This is a preliminary check, not a
 * version oracle: it doesn't distinguish a specific version, so a superseded
 * opus/sonnet 4.x id also matches; anything it misjudges surfaces the real API
 * error to the caller.
 */
const NO_SAMPLING_PARAMS = /^claude-(?:fable|mythos|sonnet|opus)-\d+(?:-\d+)?$/;

/**
 * Models that accept `thinking: { type: "adaptive" }` (and `output_config.effort`).
 * Older models (haiku-4-5 and earlier 3.x/4.x lines) reject adaptive thinking
 * (`adaptive thinking is not supported on this model`) and the effort parameter
 * (`This model does not support the effort parameter`); they take budget-based
 * thinking instead. Verified against claude-haiku-4-5 (budget-only) vs
 * claude-sonnet-5 (adaptive). Newer families default to adaptive.
 */
const ADAPTIVE_THINKING_MODELS = /^claude-(?:fable|sonnet-5|opus-4-[89])/;

/** effort → `budget_tokens` for the budget-based (non-adaptive) thinking path. */
const THINKING_BUDGETS: Record<ReasoningEffort, number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: 32768,
};

/** GA server-side web-search tool. Same result/citation wire shape as later versions. */
const WEB_SEARCH_TOOL_VERSION = "web_search_20250305";

/** Models with the server-side web-search tool (Claude 4+ / fable / mythos). */
const WEB_SEARCH_MODELS =
  /^claude-(?:opus|sonnet|haiku)-[4-9]|^claude-(?:fable|mythos)/;

/**
 * Bound on transparent `pause_turn` resumes. Each paused response already
 * represents a full server-side tool loop, so this caps total search rounds
 * generously while preventing an unbounded resume loop.
 */
const MAX_SERVER_TOOL_TURNS = 10;

interface AnthropicContentBlock {
  type: string;
  [key: string]: unknown;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  // thinking-token breakdown, if the API ever reports one separately (today
  // thinking is folded into output_tokens); defensively read both spellings
  output_tokens_details?: { thinking_tokens?: number };
  thinking_tokens?: number;
  // server-side tool invocation counts (billed per request, not in tokens)
  server_tool_use?: { web_search_requests?: number };
}

interface AnthropicMessageResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  usage?: AnthropicUsage;
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private readonly options: AnthropicProviderOptions;
  private readonly fetch: typeof globalThis.fetch;
  private readonly oauth?: ClaudeOAuthAuth;
  private lastRateLimit?: RateLimitStatus;

  /**
   * The subscription rate-limit snapshot from the most recent response that
   * carried the unified headers (OAuth/subscription requests), or `undefined`
   * if none has been seen yet. A last-known view, overwritten on each such
   * response — not an accumulator. Read it any time to check remaining quota.
   */
  get rateLimit(): RateLimitStatus | undefined {
    return this.lastRateLimit;
  }

  constructor(options: AnthropicProviderOptions = {}) {
    this.options = options;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.oauth = this.resolveOAuth(options);
  }

  /**
   * Picks the auth path. Precedence (most explicit first): config `oauth` >
   * config `apiKey` > env `CLAUDE_CODE_OAUTH_TOKEN` > env `ANTHROPIC_API_KEY`
   * (the last is handled lazily in `apiKey()`). Returning a `ClaudeOAuthAuth`
   * selects the Bearer/subscription path; `undefined` falls back to API key.
   */
  private resolveOAuth(
    options: AnthropicProviderOptions,
  ): ClaudeOAuthAuth | undefined {
    if (options.oauth) {
      const oauth =
        typeof options.oauth === "string"
          ? { credentials: { accessToken: options.oauth } }
          : options.oauth;
      return new ClaudeOAuthAuth(oauth, this.fetch);
    }
    // An explicit API key opts out of the subscription path; only fall back to
    // the env OAuth token when no credential was configured at all.
    if (options.apiKey) return undefined;
    const token = readEnv("CLAUDE_CODE_OAUTH_TOKEN");
    if (!token) return undefined;
    if (readEnv("ANTHROPIC_API_KEY")) {
      warnOnce(
        "anthropic-dual-env",
        "both CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY are set; using the " +
          "OAuth (subscription) token. Unset CLAUDE_CODE_OAUTH_TOKEN to use the API key.",
      );
    }
    // `claude setup-token` issues a long-lived, non-refreshable token.
    return new ClaudeOAuthAuth({ credentials: { accessToken: token } }, this.fetch);
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const body = await this.buildRequestBody(options, false);
    const retry = resolveRetry(options.retry ?? this.options.retry);
    const timeoutMs = resolveTimeout(options.timeoutMs, this.options.timeoutMs);
    const messages = body.messages as Array<Record<string, unknown>>;

    const content: ContentPart[] = [];
    const citations: WebCitation[] = [];
    const usage = emptyUsage();
    let finishReason: FinishReason = "other";
    let lastRaw: AnthropicMessageResponse = {};
    let rateLimit: RateLimitStatus | undefined;

    // server-side tools (web search) run a sampling loop server-side; when it
    // hits its iteration cap the response stops with `pause_turn`. Re-send the
    // assistant turn verbatim to resume, transparently, as one logical turn.
    for (let turn = 0; turn < MAX_SERVER_TOOL_TURNS; turn++) {
      const response = await withRetry(
        () => this.request("/v1/messages", body, options.signal, timeoutMs),
        retry,
        options.signal,
      );
      rateLimit = parseRateLimit(response.headers) ?? rateLimit;
      if (rateLimit) this.lastRateLimit = rateLimit;
      const raw = (await response.json()) as AnthropicMessageResponse;
      lastRaw = raw;
      for (const block of raw.content ?? []) {
        const part = convertResponseBlock(block);
        if (part) content.push(part);
        extractBlockCitations(block, citations);
      }
      addUsage(usage, mapUsage(raw.usage));
      if (raw.stop_reason !== "pause_turn") {
        finishReason = mapStopReason(raw.stop_reason);
        break;
      }
      messages.push({ role: "assistant", content: raw.content ?? [] });
    }

    const result: GenerateResult = {
      message: { role: "assistant", content },
      text: partsToText(content),
      finishReason,
      usage,
      raw: lastRaw,
    };
    if (citations.length) result.citations = citations;
    if (rateLimit) result.rateLimit = rateLimit;
    if (options.output && finishReason !== "refusal") {
      result.output = parseStructuredOutput(
        content,
        options.output.schema,
        this.name,
      );
    }
    return result;
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamEvent> {
    const body = await this.buildRequestBody(options, true);
    const retry = resolveRetry(options.retry ?? this.options.retry);
    const timeoutMs = resolveTimeout(options.timeoutMs, this.options.timeoutMs);
    const messages = body.messages as Array<Record<string, unknown>>;
    const usage = emptyUsage();
    const citations: WebCitation[] = [];
    let rateLimit: RateLimitStatus | undefined;

    for (let turn = 0; turn < MAX_SERVER_TOOL_TURNS; turn++) {
      const response = await withRetry(
        () => this.request("/v1/messages", body, options.signal, timeoutMs),
        retry,
        options.signal,
      );
      rateLimit = parseRateLimit(response.headers) ?? rateLimit;
      if (rateLimit) this.lastRateLimit = rateLimit;
      if (!response.body) {
        throw new CardanError("network", "response has no body", {
          provider: this.name,
        });
      }
      const { stopReason, rawBlocks } = yield* this.parseStreamTurn(
        response.body,
        usage,
        citations,
      );
      if (stopReason !== "pause_turn") {
        yield {
          type: "finish",
          reason: mapStopReason(stopReason),
          usage,
          ...(citations.length ? { citations } : {}),
          ...(rateLimit ? { rateLimit } : {}),
        };
        return;
      }
      messages.push({ role: "assistant", content: rawBlocks });
    }
    // resume budget exhausted; surface what we have rather than hang
    yield {
      type: "finish",
      reason: "other",
      usage,
      ...(citations.length ? { citations } : {}),
      ...(rateLimit ? { rateLimit } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Request
  // -------------------------------------------------------------------------

  private apiKey(): string {
    const key = this.options.apiKey ?? readEnv("ANTHROPIC_API_KEY");
    if (!key) {
      throw new CardanError(
        "auth",
        "missing Anthropic API key: pass `apiKey` or set ANTHROPIC_API_KEY",
        { provider: this.name },
      );
    }
    return key;
  }

  /** Auth + version headers for a request, including any user-supplied headers. */
  private async requestHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": this.options.version ?? DEFAULT_VERSION,
      ...this.options.headers,
    };
    if (this.oauth) {
      headers["authorization"] = `Bearer ${await this.oauth.accessToken()}`;
      headers["anthropic-beta"] = withBeta(headers["anthropic-beta"], OAUTH_BETA);
    } else {
      headers["x-api-key"] = this.apiKey();
    }
    return headers;
  }

  private async request(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<Response> {
    const url = `${this.options.baseUrl ?? DEFAULT_BASE_URL}${path}`;
    const payload = JSON.stringify(body);
    const { signal: composed, clear } = withTimeoutSignal(signal, timeoutMs);
    const send = async (): Promise<Response> => {
      try {
        return await this.fetch(url, {
          method: "POST",
          headers: await this.requestHeaders(),
          body: payload,
          signal: composed ?? null,
        });
      } catch (error) {
        throw wrapFetchError(error, this.name);
      }
    };

    try {
      let response = await send();
      // The server may reject a token our clock thought was valid, or one that
      // was revoked. Refresh once and retry before surfacing the error.
      if (
        !response.ok &&
        this.oauth?.canRefresh &&
        (response.status === 401 || response.status === 403)
      ) {
        await this.oauth.refresh();
        response = await send();
      }
      if (!response.ok) {
        throw await this.httpError(response);
      }
      return response;
    } finally {
      clear();
    }
  }

  private async httpError(response: Response): Promise<CardanError> {
    let raw: unknown;
    let message = `HTTP ${response.status}`;
    try {
      raw = await response.json();
      const detail = (raw as { error?: { message?: string } }).error?.message;
      if (detail) message = detail;
    } catch {
      // keep generic message; body was not JSON
    }
    let code: ErrorCode = codeFromStatus(response.status);
    if (
      code === "invalid_request" &&
      /prompt is too long|context (length|window)/i.test(message)
    ) {
      code = "context_length";
    }
    return new CardanError(code, message, {
      provider: this.name,
      status: response.status,
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      // subscription quota carries an exact reset (epoch s) in the unified
      // headers rather than Retry-After; surface it for precise pool cooldowns
      resetAt: code === "rate_limit" ? unifiedResetMs(response.headers) : undefined,
      raw,
    });
  }

  private async buildRequestBody(
    options: GenerateOptions,
    stream: boolean,
  ): Promise<Record<string, unknown>> {
    const { system, messages } = splitLeadingSystem(
      normalizeMessages(options.messages),
    );

    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      // Keep an assistant turn's thinking blocks only while a client tool call
      // is still in flight (the turn is immediately followed by tool results),
      // where Anthropic requires them; drop them from completed turns — see
      // convertMessage.
      messages: messages.map((message, i) =>
        convertMessage(message, messages[i + 1]?.role === "tool"),
      ),
    };
    // Prompt caching: place one breakpoint on the last system block (caches
    // tools + system) and one on the last message's last block (incremental
    // conversation caching). Two breakpoints, well under the 4 max. The system
    // must be rendered as a block array to carry cache_control, so caching
    // forces the array form even in API-key mode.
    const cacheControl = resolveCacheControl(options.cache);
    const omitIdentity = this.options.experimental?.omitOAuthIdentity === true;
    if (this.oauth && !omitIdentity) {
      // Subscription grant requires the identity as the first system block.
      const head: Record<string, unknown> = { type: "text", text: this.oauth.identity };
      const blocks: Record<string, unknown>[] = system
        ? [head, { type: "text", text: system }]
        : [head];
      if (cacheControl) {
        const last = blocks[blocks.length - 1];
        if (last) last.cache_control = cacheControl;
      }
      body.system = blocks;
    } else if (system) {
      body.system = cacheControl
        ? [{ type: "text", text: system, cache_control: cacheControl }]
        : system;
    }
    if (cacheControl) {
      const msgs = body.messages as Array<{ content?: unknown }>;
      const lastContent = msgs[msgs.length - 1]?.content;
      if (Array.isArray(lastContent) && lastContent.length) {
        (lastContent[lastContent.length - 1] as Record<string, unknown>)
          .cache_control = cacheControl;
      }
    }
    if (stream) body.stream = true;
    if (options.stopSequences?.length)
      body.stop_sequences = options.stopSequences;

    const dropSampling = NO_SAMPLING_PARAMS.test(options.model);
    if (!dropSampling) {
      if (options.temperature !== undefined)
        body.temperature = options.temperature;
      if (options.topP !== undefined) body.top_p = options.topP;
    }

    const tools: Array<Record<string, unknown>> = [];
    if (options.tools?.length) {
      tools.push(
        ...(await Promise.all(
          options.tools.map(async (tool) => ({
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            input_schema: tool.parameters
              ? await toJsonSchema(tool.parameters)
              : { type: "object" },
          })),
        )),
      );
    }
    const webSearch = normalizeWebSearch(options.webSearch);
    if (webSearch) {
      if (!WEB_SEARCH_MODELS.test(options.model)) {
        throw new CardanError(
          "invalid_request",
          `model "${options.model}" does not support web search`,
          { provider: this.name },
        );
      }
      tools.push(buildWebSearchTool(webSearch));
    }
    if (tools.length) body.tools = tools;
    if (options.toolChoice !== undefined) {
      body.tool_choice = convertToolChoice(options.toolChoice);
    }

    const outputConfig: Record<string, unknown> = {};
    if (options.output) {
      outputConfig.format = {
        type: "json_schema",
        schema: await toJsonSchema(options.output.schema),
      };
    }
    // reasoning is on unless explicitly disabled; `effort` implies enabled
    if (options.reasoning && options.reasoning.enabled !== false) {
      if (ADAPTIVE_THINKING_MODELS.test(options.model)) {
        body.thinking = { type: "adaptive" };
        if (options.reasoning.effort) outputConfig.effort = options.reasoning.effort;
      } else {
        // Older models reject adaptive thinking and the effort parameter; map
        // effort to a token budget and clamp within the response's max_tokens.
        const maxTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
        const budget = Math.min(
          Math.max(THINKING_BUDGETS[options.reasoning.effort ?? "medium"], 1024),
          maxTokens - 1,
        );
        body.thinking = { type: "enabled", budget_tokens: budget };
      }
    }
    if (Object.keys(outputConfig).length > 0) body.output_config = outputConfig;

    if (options.providerOptions) Object.assign(body, options.providerOptions);
    return body;
  }

  // -------------------------------------------------------------------------
  // Response
  // -------------------------------------------------------------------------

  /**
   * Parses one streamed response. Yields cardan events, accumulates `usage`
   * and `citations` into the passed cumulative collectors, and returns the
   * turn's stop reason plus the raw assistant content blocks — the latter so a
   * `pause_turn` can be resumed by replaying them verbatim. It does *not* emit
   * the `finish` event; the caller does, once the turn really ends.
   */
  private async *parseStreamTurn(
    body: ReadableStream<Uint8Array>,
    usage: Usage,
    citations: WebCitation[],
  ): AsyncGenerator<
    StreamEvent,
    { stopReason: string | null; rawBlocks: unknown[] }
  > {
    const perTurn = emptyUsage();
    const rawBlocks: Array<Record<string, unknown>> = [];
    let stopReason: string | null = null;
    // the currently open content block, rebuilt from deltas for verbatim resume
    let block: Record<string, unknown> | null = null;
    let jsonBuffer = "";

    for await (const { data } of parseSse(body)) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      switch (event.type) {
        case "message_start": {
          const message = event.message as AnthropicMessageResponse | undefined;
          mergeUsage(perTurn, message?.usage);
          break;
        }
        case "content_block_start": {
          const start = event.content_block as AnthropicContentBlock;
          // clone so deltas mutate our copy, not the parsed event
          block = { ...start };
          jsonBuffer = "";
          if (start.type === "redacted_thinking") {
            yield {
              type: "thinking_signature",
              signature: String(start.data ?? ""),
            };
          }
          break;
        }
        case "content_block_delta": {
          const delta = event.delta as Record<string, unknown>;
          switch (delta.type) {
            case "text_delta": {
              const text = String(delta.text ?? "");
              if (block) block.text = String(block.text ?? "") + text;
              yield { type: "text_delta", text };
              break;
            }
            case "thinking_delta": {
              const text = String(delta.thinking ?? "");
              if (block) block.thinking = String(block.thinking ?? "") + text;
              yield { type: "thinking_delta", text };
              break;
            }
            case "signature_delta":
              if (block) {
                block.signature =
                  String(block.signature ?? "") + String(delta.signature ?? "");
              }
              break;
            case "input_json_delta":
              jsonBuffer += String(delta.partial_json ?? "");
              break;
            case "citations_delta": {
              const citation = delta.citation as Record<string, unknown> | undefined;
              if (block && citation) {
                const list = (block.citations as unknown[]) ?? [];
                list.push(citation);
                block.citations = list;
              }
              break;
            }
          }
          break;
        }
        case "content_block_stop": {
          if (block) {
            if (block.type === "tool_use") {
              block.input = parseToolArgs(jsonBuffer, this.name);
              yield {
                type: "tool_call",
                id: String(block.id ?? ""),
                name: String(block.name ?? ""),
                args: block.input,
              };
            } else if (block.type === "server_tool_use") {
              block.input = parseToolArgs(jsonBuffer, this.name);
            } else if (block.type === "thinking") {
              const signature = String(block.signature ?? "");
              if (signature) yield { type: "thinking_signature", signature };
            } else if (block.type === "text") {
              // Anchor the block's sources to the text it backs: closes the
              // open text part so downstream collectors pin them to this claim.
              const blockCites = textBlockCitations(block as AnthropicContentBlock);
              if (blockCites.length) {
                yield { type: "text_citations", citations: blockCites };
              }
            }
            extractBlockCitations(block as AnthropicContentBlock, citations);
            rawBlocks.push(block);
            block = null;
            jsonBuffer = "";
          }
          break;
        }
        case "message_delta": {
          const delta = event.delta as
            | { stop_reason?: string | null }
            | undefined;
          if (delta?.stop_reason) stopReason = delta.stop_reason;
          mergeUsage(perTurn, event.usage as AnthropicUsage | undefined);
          break;
        }
        case "message_stop":
          addUsage(usage, perTurn);
          return { stopReason, rawBlocks };
        case "error": {
          const error = event.error as
            | { type?: string; message?: string }
            | undefined;
          throw new CardanError(
            error?.type === "overloaded_error" ? "overloaded" : "server",
            error?.message ?? "stream error",
            { provider: this.name, raw: event, retryable: false },
          );
        }
      }
    }
    // stream ended without message_stop (connection cut)
    throw new CardanError("network", "stream ended unexpectedly", {
      provider: this.name,
    });
  }
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

function buildWebSearchTool(
  options: WebSearchOptions,
): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: WEB_SEARCH_TOOL_VERSION,
    name: "web_search",
  };
  if (options.maxUses !== undefined) tool.max_uses = options.maxUses;
  if (options.allowedDomains?.length) tool.allowed_domains = options.allowedDomains;
  if (options.blockedDomains?.length) tool.blocked_domains = options.blockedDomains;
  if (options.userLocation) {
    const loc = options.userLocation;
    tool.user_location = {
      type: "approximate",
      ...(loc.city ? { city: loc.city } : {}),
      ...(loc.region ? { region: loc.region } : {}),
      ...(loc.country ? { country: loc.country } : {}),
      ...(loc.timezone ? { timezone: loc.timezone } : {}),
    };
  }
  return tool;
}

/**
 * Pulls web-search sources out of a content block: server-tool result blocks
 * carry the result list, and answer text blocks carry per-claim citations.
 */
function extractBlockCitations(
  block: AnthropicContentBlock,
  out: WebCitation[],
): void {
  if (block.type === "web_search_tool_result") {
    const items = Array.isArray(block.content) ? block.content : [];
    for (const item of items as Array<Record<string, unknown>>) {
      if (item?.type === "web_search_result" && item.url) {
        addCitations(out, [
          {
            url: String(item.url),
            ...(item.title ? { title: String(item.title) } : {}),
          },
        ]);
      }
    }
  } else if (block.type === "text") {
    addCitations(out, textBlockCitations(block));
  }
}

/**
 * Maps the citations Anthropic attaches to an answer text block into cardan
 * {@link WebCitation}s (url + title + the quoted source span). Returns [] for
 * blocks without citations.
 */
function textBlockCitations(block: AnthropicContentBlock): WebCitation[] {
  if (block.type !== "text" || !Array.isArray(block.citations)) return [];
  const out: WebCitation[] = [];
  for (const c of block.citations as Array<Record<string, unknown>>) {
    if (c?.url) {
      out.push({
        url: String(c.url),
        ...(c.title ? { title: String(c.title) } : {}),
        ...(c.cited_text ? { snippet: String(c.cited_text) } : {}),
      });
    }
  }
  return out;
}


/**
 * Converts one normalized message to Anthropic wire format.
 *
 * `keepThinking` gates replaying the turn's thinking blocks. Anthropic rejects
 * *modified* thinking blocks in an assistant turn ("`thinking` … blocks in the
 * latest assistant message cannot be modified"), and a web-search turn cannot
 * be replayed faithfully: its interleaved `server_tool_use` /
 * `web_search_tool_result` blocks don't round-trip through the generic schema
 * (they're dropped on the way in), so keeping the thinking blocks but losing
 * their surrounding blocks reads as a modified turn. Thinking from a *completed*
 * turn is optional, so we drop it; we keep it only for an in-flight client
 * tool-use turn — one immediately followed by tool results — where the API
 * requires the thinking that led to the tool call.
 */
function convertMessage(
  message: Message,
  keepThinking: boolean,
): Record<string, unknown> {
  // tool results travel in user-role messages on Anthropic
  const role = message.role === "tool" ? "user" : message.role;
  const parts = keepThinking
    ? message.content
    : message.content.filter((part) => part.type !== "thinking");
  return {
    role,
    content: parts.map(convertRequestPart).filter((part) => part !== null),
  };
}

function convertRequestPart(part: ContentPart): Record<string, unknown> | null {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image":
      return {
        type: "image",
        source:
          part.data instanceof URL
            ? { type: "url", url: part.data.href }
            : {
                type: "base64",
                media_type: part.mimeType,
                data: bytesToBase64(part.data),
              },
      };
    case "tool_call":
      return {
        type: "tool_use",
        id: part.id,
        name: part.name,
        input: part.args,
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: part.callId,
        content:
          typeof part.result === "string"
            ? part.result
            : JSON.stringify(part.result),
        ...(part.isError ? { is_error: true } : {}),
      };
    case "thinking":
      if (part.redacted) {
        return { type: "redacted_thinking", data: part.signature ?? "" };
      }
      // unsigned thinking cannot be replayed; drop it
      if (!part.signature) return null;
      return {
        type: "thinking",
        thinking: part.text,
        signature: part.signature,
      };
  }
}

function convertToolChoice(
  choice: NonNullable<GenerateOptions["toolChoice"]>,
): Record<string, unknown> {
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  return { type: "tool", name: choice.name };
}

function convertResponseBlock(
  block: AnthropicContentBlock,
): ContentPart | null {
  switch (block.type) {
    case "text": {
      const cites = textBlockCitations(block);
      return {
        type: "text",
        text: String(block.text ?? ""),
        ...(cites.length ? { citations: cites } : {}),
      };
    }
    case "thinking":
      return {
        type: "thinking",
        text: String(block.thinking ?? ""),
        ...(typeof block.signature === "string" && block.signature
          ? { signature: block.signature }
          : {}),
      };
    case "redacted_thinking":
      return {
        type: "thinking",
        text: "",
        signature: String(block.data ?? ""),
        redacted: true,
      };
    case "tool_use":
      return {
        type: "tool_call",
        id: String(block.id ?? ""),
        name: String(block.name ?? ""),
        args: block.input,
      };
    default:
      // unknown block types (server tool results, citations, …) are kept in
      // `raw` but not mapped into the generic schema
      return null;
  }
}

function mapStopReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

function mapUsage(usage: AnthropicUsage | undefined): Usage {
  const result = emptyUsage();
  mergeUsage(result, usage);
  return result;
}

function mergeUsage(target: Usage, usage: AnthropicUsage | undefined): void {
  if (!usage) return;
  const cacheRead = usage.cache_read_input_tokens;
  const cacheWrite = usage.cache_creation_input_tokens;
  if (
    usage.input_tokens !== undefined ||
    cacheRead !== undefined ||
    cacheWrite !== undefined
  ) {
    // Anthropic's input_tokens excludes cached tokens; total = sum of all three
    target.input.total =
      (usage.input_tokens ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
    if (cacheRead) target.input.details.cache_read = cacheRead;
    if (cacheWrite) target.input.details.cache_write = cacheWrite;
  }
  if (usage.output_tokens !== undefined) {
    target.output.total = usage.output_tokens;
  }
  // reasoning tokens are already counted inside output_tokens; expose the
  // breakdown in details without double-counting the total
  const reasoning =
    usage.output_tokens_details?.thinking_tokens ?? usage.thinking_tokens;
  if (reasoning !== undefined) target.output.details.reasoning = reasoning;
  // web-search count is a billed request tally, not tokens; surfaced for
  // accounting under a clearly-named key
  const searches = usage.server_tool_use?.web_search_requests;
  if (searches) target.output.details.web_search_requests = searches;
}

