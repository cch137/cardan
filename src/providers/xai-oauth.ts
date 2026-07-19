import { CardanError, codeFromStatus, wrapFetchError } from "../errors.js";
import { OAuthTokenManager } from "../oauth.js";
import type {
  GenerateOptions,
  Provider,
  RateLimitStatus,
  RetryOptions,
} from "../types.js";
import { GroqProvider } from "./groq.js";

/**
 * Grok CLI subscription (SuperGrok) inference for cardan.
 *
 * The Grok CLI does not bill against the pay-per-token xAI API. `grok login`
 * mints an OAuth session token and inference goes through a proxy that speaks
 * the **OpenAI Chat Completions** wire format:
 *
 *   POST https://cli-chat-proxy.grok.com/v1/chat/completions
 *   Authorization: Bearer <access_token from ~/.grok/auth.json>
 *   X-XAI-Token-Auth: xai-grok-cli        # validate bearer as a CLI session
 *   x-grok-model-override: <model>        # proxy routes on this, not body.model
 *   Content-Type: application/json
 *
 * This is the Grok analogue of the Claude.ai-subscription OAuth path in
 * `anthropic.ts`. Because the proxy uses Chat Completions (not xAI's Responses
 * API that `xai.ts` targets), this reuses the {@link GroqProvider} Chat
 * Completions machinery and only swaps auth, base URL, and the two CLI headers.
 * The proxy streams reasoning by default as `delta.reasoning_content` (xAI
 * style; Groq uses `reasoning`) — GroqProvider reads both.
 *
 * cardan stays fetch-only: this takes credentials, it does NOT read
 * `~/.grok/auth.json` itself. Load the token yourself (bin/grok-token.sh, or
 * `JSON.parse(fs.readFileSync("~/.grok/auth.json"))[GROK_AUTH_SCOPE]`) and pass
 * `{ accessToken, refreshToken, expiresAt }`.
 *
 * Using subscription quota outside the official CLI likely violates xAI's
 * terms, and the `X-XAI-Token-Auth` header is an explicit "I am the CLI" claim.
 * Use accordingly.
 */

/** Default proxy base; the Groq machinery appends `/v1/chat/completions`. */
const DEFAULT_PROXY_BASE = "https://cli-chat-proxy.grok.com";
/** OAuth token endpoint for the refresh grant (`accounts.x.ai`). */
const DEFAULT_TOKEN_URL = "https://accounts.x.ai/oauth2/token";
/** The Grok CLI's public OAuth client id. */
const DEFAULT_CLIENT_ID = "grok-cli";
/** Header that tells the proxy to validate the bearer as a CLI session token. */
const TOKEN_AUTH_HEADER = "x-xai-token-auth";
const TOKEN_AUTH_VALUE = "xai-grok-cli";
/** Header the proxy routes on (in place of the JSON body `model`). */
const MODEL_OVERRIDE_HEADER = "x-grok-model-override";
/**
 * The proxy rejects stale/absent clients with HTTP 426 ("Grok CLI version
 * (none) is outdated") below a minimum-version floor. The floor lags the
 * current release by ~2 months and moves slowly (floor 0.1.202 shipped
 * 2026-05-07; this default 0.2.93 shipped 2026-07-08), so a monthly bump keeps
 * a comfortable margin. If a 426 ever surfaces, pass a newer `clientVersion`.
 */
const CLIENT_VERSION_HEADER = "x-grok-client-version";
const DEFAULT_CLIENT_VERSION = "0.2.93";
/** The client surface the real CLI advertises; harmless constant. */
const CLIENT_SURFACE_HEADER = "x-grok-client-surface";
const DEFAULT_CLIENT_SURFACE = "grok-shell";

/**
 * The `~/.grok/auth.json` scope key under which `grok login` stores the OIDC
 * session token: `{ "<scope>": { "key": <accessToken>, "refresh_token": ... } }`.
 * The `::` suffix is the audience UUID; override if yours differs.
 */
export const GROK_AUTH_SCOPE =
  "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";

/**
 * SuperGrok **weekly** usage pool (shared across Chat / Build / Imagine / …),
 * from `GET /v1/billing?format=credits` — what the CLI's `/usage show` reads.
 *
 * Distinct from bare `GET /v1/billing` (monthly credit ledger) and from
 * per-response `x-ratelimit-*` throttle counters.
 */
export interface XAISubscriptionUsage {
  /** Fraction of the weekly pool consumed, 0..1. */
  utilization: number;
  /** Same as utilization × 100 (`creditUsagePercent`). */
  percent: number;
  /** Period kind from the API, e.g. `USAGE_PERIOD_TYPE_WEEKLY`. */
  periodType: string;
  /** Current period start, epoch ms. */
  periodStart?: number;
  /** Current period end (reset time), epoch ms. */
  periodEnd?: number;
  /** Per-product share of the pool (percent 0..100 when reported). */
  products: Array<{ product: string; usagePercent?: number }>;
  /** Extra Usage Credits balance (prepaid), credits. */
  prepaidBalance: number;
  /** On-demand overage cap; `0` = disabled. */
  onDemandCap: number;
  /** On-demand credits used this period. */
  onDemandUsed: number;
  /** Unified billing user (shared weekly pool across products). */
  isUnified: boolean;
  /**
   * Same snapshot as {@link RateLimitStatus} for pool / ops observability —
   * populates `sevenDay` (+ representative/status/resetAt).
   */
  rateLimit: RateLimitStatus;
  /** Raw `config` object from the response, for forward-compat. */
  raw: unknown;
}

interface CreditsBillingConfig {
  currentPeriod?: { type?: string; start?: string; end?: string };
  creditUsagePercent?: number;
  productUsage?: Array<{ product?: string; usagePercent?: number }>;
  prepaidBalance?: { val?: number };
  onDemandCap?: { val?: number };
  onDemandUsed?: { val?: number };
  isUnifiedBillingUser?: boolean;
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
}

/** A Grok CLI OAuth credential set, as stored in `~/.grok/auth.json`. */
export interface XAIOAuthCredentials {
  /** Bearer sent to the proxy — the `key` field in `~/.grok/auth.json`. */
  accessToken: string;
  /** Mints new access tokens; rotates on refresh. Absent = refresh disabled. */
  refreshToken?: string | null;
  /** Epoch ms. Absent means unknown — no proactive refresh, refresh on 401 only. */
  expiresAt?: number | null;
}

export interface XAIOAuthProviderOptions {
  /** The `grok login` credential set (from `~/.grok/auth.json`). */
  credentials: XAIOAuthCredentials;
  /**
   * Called after each successful refresh with the rotated credentials. Persist
   * them back to `~/.grok/auth.json` — the old refresh token stops working once
   * a new one is issued.
   */
  onRefresh?: (credentials: Required<XAIOAuthCredentials>) => void | Promise<void>;
  /**
   * Re-read credentials from the persistence layer before a network refresh;
   * externally rotated credentials are adopted without a token-endpoint call.
   */
  reload?: () =>
    | XAIOAuthCredentials
    | undefined
    | Promise<XAIOAuthCredentials | undefined>;
  /** Override the OAuth token endpoint (default `accounts.x.ai/oauth2/token`). */
  tokenUrl?: string;
  /** Override the OAuth client id (default `grok-cli`). */
  clientId?: string;
  /** Override the proxy base URL (default `cli-chat-proxy.grok.com`). */
  baseUrl?: string;
  /**
   * CLI version sent as `x-grok-client-version` (default `0.2.93`). The proxy
   * 426s clients below its floor (>= 0.1.202 when verified); raise this if the
   * proxy starts rejecting the default.
   */
  clientVersion?: string;
  /** Client surface sent as `x-grok-client-surface` (default `grok-shell`). */
  clientSurface?: string;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  /** Custom fetch implementation (testing, proxies). */
  fetch?: typeof globalThis.fetch;
  /** Default retry behavior for all requests; `false` disables. */
  retry?: Partial<RetryOptions> | false;
  /** Default per-attempt timeout (ms) for all requests; `0`/undefined disables. */
  timeoutMs?: number;
}

/**
 * Manages the Grok OAuth credential. Lifecycle (proactive + single-flight
 * refresh, on-401 fallback, rotation persistence, non-fatal persist failure)
 * lives in {@link OAuthTokenManager}; this subclass adds only the form-encoded
 * token exchange and the CLI-header-injecting {@link wrapFetch}.
 */
class GrokOAuth extends OAuthTokenManager<XAIOAuthCredentials> {
  constructor(
    private readonly opts: XAIOAuthProviderOptions,
    fetchImpl: typeof globalThis.fetch,
  ) {
    super(
      {
        provider: "xai-oauth",
        credentials: opts.credentials,
        onRefresh: opts.onRefresh,
        reload: opts.reload,
      },
      fetchImpl,
    );
  }

  protected noRefreshMessage(): string {
    return "xai oauth: no refresh token; re-run `grok login`";
  }

  protected async fetchRefreshedCredentials(
    refreshToken: string,
  ): Promise<Required<XAIOAuthCredentials>> {
    let res: Response;
    try {
      // Standard OAuth2 token endpoint: form-encoded, unlike Anthropic's JSON.
      res = await this.fetchImpl(this.opts.tokenUrl ?? DEFAULT_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: this.opts.clientId ?? DEFAULT_CLIENT_ID,
        }).toString(),
      });
    } catch (error) {
      throw wrapFetchError(error, "xai-oauth");
    }
    if (!res.ok) {
      throw new CardanError(
        "auth",
        `xai oauth: token refresh failed (HTTP ${res.status}); re-run \`grok login\``,
        { provider: "xai-oauth", status: res.status },
      );
    }
    let data: {
      access_token?: string;
      key?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      // accounts.x.ai intermittently serves an HTML challenge page with a 200.
      throw new CardanError(
        "server",
        "xai oauth: token endpoint returned non-JSON response",
        { provider: "xai-oauth", status: res.status },
      );
    }
    const accessToken = data.access_token ?? data.key;
    if (!accessToken) {
      throw new CardanError("auth", "xai oauth: refresh response had no access token", {
        provider: "xai-oauth",
      });
    }
    return {
      accessToken,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt:
        typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : null,
    };
  }

  /** A fetch that injects auth + CLI headers and refreshes once on a 401/403. */
  wrapFetch(base: typeof globalThis.fetch): typeof globalThis.fetch {
    const self = this;
    return async function authedFetch(input, init) {
      // The bearer this attempt sent, so the on-401 refresh can skip a redundant
      // rotation if a concurrent request already refreshed.
      let tokenUsed = "";
      const send = async (): Promise<Response> => {
        const headers = new Headers(init?.headers);
        tokenUsed = await self.accessToken();
        headers.set("authorization", `Bearer ${tokenUsed}`);
        headers.set(TOKEN_AUTH_HEADER, TOKEN_AUTH_VALUE);
        headers.set(CLIENT_VERSION_HEADER, self.opts.clientVersion ?? DEFAULT_CLIENT_VERSION);
        headers.set(CLIENT_SURFACE_HEADER, self.opts.clientSurface ?? DEFAULT_CLIENT_SURFACE);
        const model = modelFromBody(init?.body);
        if (model) headers.set(MODEL_OVERRIDE_HEADER, model);
        return base(input, { ...init, headers });
      };
      let res = await send();
      // Access token rejected: refresh once and replay (proactive refresh only
      // fires when `expiresAt` is known, so tokens with unknown expiry land here).
      if ((res.status === 401 || res.status === 403) && self.canRefresh) {
        await self.refreshIfUnchanged(tokenUsed);
        res = await send();
      }
      // Surface proxy errors to the app layer: the proxy returns `{"error":
      // "<message>"}` (string), but the Chat Completions error path only reads
      // `error.message` (object), so without this the real message — e.g. the
      // 426 "Grok CLI version is outdated" — is dropped for a generic HTTP code.
      return res.ok ? res : normalizeErrorBody(res);
    };
  }
}

/** Rebuild a non-OK response so a string `error` becomes `{ error: { message } }`. */
async function normalizeErrorBody(res: Response): Promise<Response> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return res;
  }
  let message: string | undefined;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string") message = parsed.error;
  } catch {
    // non-JSON body: expose it verbatim as the message
    if (text) message = text;
  }
  if (message === undefined) {
    // Already object-shaped (or empty); re-emit unchanged (body was consumed).
    return new Response(text, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }
  if (res.status === 426) {
    message += " — set `clientVersion` to a current Grok CLI version";
  }
  return new Response(JSON.stringify({ error: { message } }), {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

/** Pull `model` out of a serialized Chat Completions request body, if present. */
function modelFromBody(body: unknown): string | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const model = (JSON.parse(body) as { model?: unknown }).model;
    return typeof model === "string" ? model : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Grok CLI subscription provider. Speaks Chat Completions against the CLI chat
 * proxy with the `grok login` OAuth token. Pass standard xAI model ids
 * (e.g. `grok-4.5`); the proxy also accepts the CLI's own `grok-build`.
 *
 * Quota: call {@link subscriptionUsage} (or rely on ops refresh) to load the
 * weekly SuperGrok pool into {@link rateLimit}.`sevenDay` — same shape pool
 * members and Anthropic OAuth already expose for observability.
 */
export class XAIOAuthProvider extends GroqProvider {
  override readonly name: string = "xai-oauth";
  private readonly proxyBase: string;
  private readonly authedFetch: typeof globalThis.fetch;
  /** Last weekly-pool snapshot, merged into {@link rateLimit}. */
  private lastSubscriptionLimit?: RateLimitStatus;

  constructor(options: XAIOAuthProviderOptions) {
    const base = options.baseUrl ?? DEFAULT_PROXY_BASE;
    const auth = new GrokOAuth(options, options.fetch ?? globalThis.fetch);
    const authedFetch = auth.wrapFetch(options.fetch ?? globalThis.fetch);
    super({
      baseUrl: base,
      // Placeholder: the wrapped fetch always overrides the Authorization
      // header, so GroqProvider's own api-key check never sends this value.
      apiKey: "oauth",
      headers: options.headers,
      fetch: authedFetch,
      retry: options.retry,
      timeoutMs: options.timeoutMs,
    });
    this.proxyBase = base;
    this.authedFetch = authedFetch;
  }

  /**
   * Weekly subscription pool + last-seen `x-ratelimit-*` throttle counters.
   * Pool / ops read this via {@link Provider.rateLimit} and
   * {@link PoolProvider.rateLimits}.
   */
  override get rateLimit(): RateLimitStatus | undefined {
    const throttle = super.rateLimit;
    const sub = this.lastSubscriptionLimit;
    if (!sub && !throttle) return undefined;
    if (!sub) return throttle;
    if (!throttle) return sub;
    return {
      ...throttle,
      ...sub,
      requests: throttle.requests,
      tokens: throttle.tokens,
      sevenDay: sub.sevenDay,
      representative: sub.representative ?? throttle.representative,
      status: sub.status ?? throttle.status,
      resetAt: sub.resetAt ?? throttle.resetAt,
    };
  }

  /** Drop throttle + weekly-pool snapshots (admin force-clear). */
  override clearRateLimit(): void {
    super.clearRateLimit();
    this.lastSubscriptionLimit = undefined;
  }

  /**
   * Fetch the SuperGrok weekly usage pool (`GET /v1/billing?format=credits`)
   * and cache it on {@link rateLimit}. Safe to call from ops / admin; not
   * required on every chat turn.
   */
  async subscriptionUsage(): Promise<XAISubscriptionUsage> {
    let res: Response;
    try {
      res = await this.authedFetch(
        `${this.proxyBase}/v1/billing?format=credits`,
        { method: "GET" },
      );
    } catch (error) {
      throw wrapFetchError(error, this.name);
    }
    if (!res.ok) {
      throw new CardanError(
        codeFromStatus(res.status),
        `xai subscription usage: HTTP ${res.status}`,
        { provider: this.name, status: res.status },
      );
    }
    const body = (await res.json()) as { config?: CreditsBillingConfig };
    const config = body?.config ?? {};
    const usage = parseCreditsConfig(config);
    this.lastSubscriptionLimit = usage.rateLimit;
    return usage;
  }

  /**
   * Unlike Groq (which side-channels usage via `x_groq.usage`), the CLI proxy
   * follows stock Chat Completions semantics: streaming responses carry no
   * usage unless `stream_options.include_usage` is requested, so without this
   * every streamed turn reports zero tokens.
   */
  protected override async buildRequestBody(
    options: GenerateOptions,
    stream: boolean,
  ): Promise<Record<string, unknown>> {
    const body = await super.buildRequestBody(options, stream);
    if (stream && body.stream_options === undefined) {
      body.stream_options = { include_usage: true };
    }
    return body;
  }
}

function parseCreditsConfig(config: CreditsBillingConfig): XAISubscriptionUsage {
  const percent = clampPercent(config.creditUsagePercent);
  const utilization = percent / 100;
  const periodType =
    typeof config.currentPeriod?.type === "string"
      ? config.currentPeriod.type
      : "USAGE_PERIOD_TYPE_WEEKLY";
  const periodStart =
    dateMs(config.currentPeriod?.start) ?? dateMs(config.billingPeriodStart);
  const periodEnd =
    dateMs(config.currentPeriod?.end) ?? dateMs(config.billingPeriodEnd);
  const status =
    utilization >= 1
      ? "rejected"
      : utilization >= 0.9
        ? "allowed_warning"
        : "allowed";

  const rateLimit: RateLimitStatus = {
    representative: "seven_day",
    status,
    sevenDay: {
      utilization,
      resetAt: periodEnd ?? 0,
      status,
    },
  };
  if (periodEnd !== undefined) {
    rateLimit.resetAt = periodEnd;
    rateLimit.sevenDay = {
      utilization,
      resetAt: periodEnd,
      status,
    };
  } else {
    // No reset time: still expose utilization without a fake epoch.
    rateLimit.sevenDay = { utilization, resetAt: 0, status };
  }

  const products = (config.productUsage ?? [])
    .filter((p): p is { product: string; usagePercent?: number } =>
      typeof p?.product === "string"
    )
    .map((p) => ({
      product: p.product,
      ...(typeof p.usagePercent === "number"
        ? { usagePercent: clampPercent(p.usagePercent) }
        : {}),
    }));

  return {
    utilization,
    percent,
    periodType,
    ...(periodStart !== undefined ? { periodStart } : {}),
    ...(periodEnd !== undefined ? { periodEnd } : {}),
    products,
    prepaidBalance: numVal(config.prepaidBalance),
    onDemandCap: numVal(config.onDemandCap),
    onDemandUsed: numVal(config.onDemandUsed),
    isUnified: config.isUnifiedBillingUser === true,
    rateLimit,
    raw: config,
  };
}

function clampPercent(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

function numVal(x: { val?: number } | undefined): number {
  return typeof x?.val === "number" && Number.isFinite(x.val) ? x.val : 0;
}

function dateMs(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Convenience factory mirroring the other cardan provider constructors. */
export function createXAIOAuthProvider(options: XAIOAuthProviderOptions): Provider {
  return new XAIOAuthProvider(options);
}
