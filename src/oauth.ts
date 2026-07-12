import { CardanError } from "./errors.js";

/** Proactive-refresh lead time: refresh this many ms before `expiresAt`. */
export const DEFAULT_OAUTH_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/** The common shape every subscription OAuth credential set carries. */
export interface OAuthCredentialsBase {
  /** Bearer sent to the inference API. */
  accessToken: string;
  /** Mints new access tokens; rotates on refresh. Absent = refresh disabled. */
  refreshToken?: string | null;
  /** Epoch ms. Absent = unknown, so no proactive refresh (refresh on 401 only). */
  expiresAt?: number | null;
}

export interface OAuthManagerOptions<C extends OAuthCredentialsBase> {
  /** Provider name for error attribution (e.g. `anthropic`, `xai-oauth`). */
  provider: string;
  /** Initial credential set; `accessToken` is required. */
  credentials: C;
  /**
   * Persist rotated credentials after each successful refresh — the previous
   * refresh token stops working once a new one is issued.
   */
  onRefresh?: (credentials: Required<C>) => void | Promise<void>;
  /** Override the proactive-refresh lead time (default 5 min). */
  expiryBufferMs?: number;
}

/**
 * Shared OAuth access-token lifecycle for the subscription providers
 * (Claude.ai, Grok CLI). Owns proactive + single-flight refresh and rotation
 * persistence; subclasses supply only the provider-specific token exchange
 * ({@link fetchRefreshedCredentials}) and the "no refresh token" message.
 *
 * Freshness contract:
 * - {@link accessToken} refreshes proactively when within `expiryBufferMs` of
 *   expiry and a refresh token is present; otherwise it returns the held token.
 * - Concurrent refreshes collapse into one round-trip (`inFlight`).
 * - {@link refreshIfUnchanged} is the on-401 fallback: it refreshes only if the
 *   held token still matches the one the failed request used, so overlapping
 *   401s don't each rotate the refresh token.
 * - A rotated credential set is adopted in memory before persistence; a failing
 *   `onRefresh` is surfaced as a warning but never aborts the request — the
 *   in-memory token is valid and the process can keep serving.
 *
 * Secrecy: tokens live only in memory and are never placed in thrown errors.
 */
export abstract class OAuthTokenManager<C extends OAuthCredentialsBase> {
  protected creds: C;
  private inFlight: Promise<void> | null = null;
  private readonly provider: string;
  private readonly onRefresh?: (credentials: Required<C>) => void | Promise<void>;
  private readonly expiryBufferMs: number;

  constructor(
    options: OAuthManagerOptions<C>,
    protected readonly fetchImpl: typeof globalThis.fetch,
  ) {
    if (!options.credentials?.accessToken) {
      throw new CardanError(
        "auth",
        `${options.provider} oauth: credentials.accessToken is required`,
        { provider: options.provider },
      );
    }
    this.provider = options.provider;
    this.onRefresh = options.onRefresh;
    this.expiryBufferMs = options.expiryBufferMs ?? DEFAULT_OAUTH_EXPIRY_BUFFER_MS;
    this.creds = { ...options.credentials };
  }

  get canRefresh(): boolean {
    return Boolean(this.creds.refreshToken);
  }

  /** The access token currently held, without triggering a refresh. */
  get currentAccessToken(): string {
    return this.creds.accessToken;
  }

  private get expired(): boolean {
    const e = this.creds.expiresAt;
    return e != null && Date.now() + this.expiryBufferMs >= e;
  }

  /** A valid access token, refreshing first if near expiry and refreshable. */
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

  /**
   * On-401 refresh: refresh only if the held access token still equals
   * `usedToken`. If a concurrent request already rotated it, this is a no-op —
   * the caller then just replays with the current token, avoiding a redundant
   * round-trip and an extra refresh-token rotation.
   */
  async refreshIfUnchanged(usedToken: string): Promise<void> {
    if (this.creds.accessToken !== usedToken) return;
    await this.refresh();
  }

  private async doRefresh(): Promise<void> {
    const refreshToken = this.creds.refreshToken;
    if (!refreshToken) {
      throw new CardanError("auth", this.noRefreshMessage(), { provider: this.provider });
    }
    const next = await this.fetchRefreshedCredentials(refreshToken);
    // Adopt in memory first so the process keeps serving even if persistence
    // fails; the server has already rotated, so this matches the server state.
    this.creds = next;
    if (this.onRefresh) {
      try {
        await this.onRefresh(next);
      } catch (error) {
        // A persistence failure must not fail the request — the in-memory token
        // is valid. Warn instead: the rotated refresh token was not saved and
        // will be lost on restart (the next reload would need a re-login).
        const cause = error instanceof Error ? error.message : String(error);
        console.warn(
          `[cardan] ${this.provider} oauth: failed to persist refreshed credentials (${cause}); ` +
            "the current token still works, but the rotated refresh token was not saved " +
            "and will be lost on restart",
        );
      }
    }
  }

  /** Exchange a refresh token for a full, rotated credential set. */
  protected abstract fetchRefreshedCredentials(
    refreshToken: string,
  ): Promise<Required<C>>;

  /** Error message when a refresh is requested but no refresh token exists. */
  protected abstract noRefreshMessage(): string;
}
