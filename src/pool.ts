import { CardanError, isCardanError, type ErrorCode } from "./errors.js";
import { warnOnce } from "./env.js";
import type {
  EmbedOptions,
  EmbedResult,
  GenerateOptions,
  GenerateResult,
  Provider,
  RateLimitStatus,
  RetryOptions,
  StreamEvent,
} from "./types.js";

/**
 * A pool member: an underlying provider, its rotation weight, and a label.
 * The provider already carries its own credentials (api key / OAuth), so the
 * pool only decides *which* member serves a request and *when* to switch.
 */
export interface PoolMember {
  /** A fully configured provider (e.g. `new AnthropicProvider({ oauth })`). */
  provider: Provider;
  /**
   * Relative weight; the member appears this many times in the rotation.
   * Must be a positive integer. Default 1.
   */
  weight?: number;
  /**
   * Human-readable id used in failover logs. Never the secret — defaults to
   * `${provider.name}[${index}]`.
   */
  label?: string;
}

/** Passed to {@link PoolOptions.onFailover} on each account switch. */
export interface PoolFailoverInfo {
  /** Provider name shared by the pool members. */
  provider: string;
  /** Label of the member that just failed. */
  fromLabel: string;
  /** Label of the member being switched to. */
  toLabel: string;
  /** 0-based index of the failed attempt within this request. */
  attempt: number;
  /** The error that triggered the switch. */
  error: CardanError;
}

/** Pool tuning shared by every pool, independent of its members. */
export interface PoolBehavior {
  /**
   * Max number of account switches on failure. Default: distinct members − 1
   * (each member is tried at most once per request). `0` disables failover.
   */
  maxFailovers?: number;
  /**
   * Decides whether an error should trigger a switch to the next account.
   * Default: `rate_limit | auth | server | network | timeout`. `aborted` is
   * always treated as non-failover (caller-initiated cancellation).
   */
  shouldFailover?: (error: CardanError) => boolean;
  /**
   * Cap on the cooldown derived from an error's *relative* `retryAfterMs`, in ms.
   * Default 15 min. Bounds an over-long or hostile `Retry-After`; a member is
   * re-tried after at most this long even if the header asked for more. An
   * *absolute* `error.resetAt` (e.g. a subscription window reset) is exact and is
   * honored as-is, not capped.
   */
  maxCooldownMs?: number;
  /**
   * Called on each switch. When set, it *replaces* the default `console.warn`
   * (so structured logging / metrics don't double up with console noise).
   */
  onFailover?: (info: PoolFailoverInfo) => void;
}

/**
 * A pool member: either a bare provider (weight 1, auto-labeled) or a
 * {@link PoolMember} when you need a custom weight or label.
 */
export type PoolMemberInput = Provider | PoolMember;

export interface PoolOptions extends PoolBehavior {
  /** Pool members; at least one required. */
  members: PoolMemberInput[];
}

interface ResolvedMember {
  provider: Provider;
  index: number;
  weight: number;
  label: string;
}

/** Errors worth switching accounts for: transient faults plus auth issues. */
const FAILOVER_CODES = new Set<ErrorCode>([
  "rate_limit",
  "auth",
  "server",
  "network",
  "timeout",
]);

function defaultShouldFailover(error: CardanError): boolean {
  return FAILOVER_CODES.has(error.code);
}

/**
 * Builds an evenly interleaved rotation from per-member weights. A member with
 * weight `w` appears `w` times, spread as uniformly as possible: each of its
 * occurrences is placed at fractional position `(j + 0.5) / w`, and all
 * occurrences across members are ordered by that position (ties broken by
 * member index). E.g. weights `[2, 1]` → `[0, 1, 0]` (member 0 at the start
 * and the middle), `[2, 2]` → `[0, 1, 0, 1]`.
 *
 * Returns a flat list of member indices. Exported for testing.
 */
export function buildRotation(weights: number[]): number[] {
  const slots: Array<{ pos: number; idx: number }> = [];
  weights.forEach((weight, idx) => {
    for (let j = 0; j < weight; j++) {
      slots.push({ pos: (j + 0.5) / weight, idx });
    }
  });
  slots.sort((a, b) => a.pos - b.pos || a.idx - b.idx);
  return slots.map((slot) => slot.idx);
}

/** Default cap for retry-after-derived cooldowns. */
const DEFAULT_MAX_COOLDOWN_MS = 15 * 60 * 1000;

function resolveWeight(weight: number | undefined, label: string): number {
  if (weight === undefined) return 1;
  if (!Number.isInteger(weight) || weight < 1) {
    throw new CardanError(
      "invalid_request",
      `pool member "${label}" has invalid weight ${weight}: must be a positive integer`,
    );
  }
  return weight;
}

/**
 * An account pool that satisfies the {@link Provider} interface, so it can be
 * used directly or injected via `new Cardan({ providers: { anthropic: pool } })`.
 *
 * On construction it generates a fixed, evenly interleaved rotation from the
 * members' weights; each request takes the next slot round-robin. On a
 * failover-class error it switches to the next *distinct* member and retries,
 * emitting a warning. Since the pool owns the cross-account retry, it disables
 * the underlying provider's own retry per attempt when ≥2 members are tried, or
 * on an all-cooling last-ditch attempt (avoids hanging on a long Retry-After).
 * A single ready member still preserves the caller's retry. For `stream`, a
 * switch is only possible before the first event is yielded.
 */
export class PoolProvider implements Provider {
  readonly name: string;
  embed?: (options: EmbedOptions) => Promise<EmbedResult>;

  private readonly members: ResolvedMember[];
  private readonly sequence: number[];
  private readonly maxFailovers: number;
  private readonly maxCooldownMs: number;
  private readonly shouldFailover: (error: CardanError) => boolean;
  private readonly onFailover?: (info: PoolFailoverInfo) => void;
  /** Per-(member, model) cooldown deadlines (epoch ms), from a relative `retryAfterMs`; keyed by {@link cooldownKey}. */
  private readonly cooldowns = new Map<string, number>();
  /** Per-member cooldown deadlines (epoch ms), from an account-wide absolute `resetAt`; keyed by member index. */
  private readonly memberCooldowns = new Map<number, number>();
  private cursor = 0;

  constructor(options: PoolOptions) {
    const input = options.members;
    if (!input?.length) {
      throw new CardanError("invalid_request", "pool requires at least one member");
    }
    this.members = input.map((input, i) => {
      const member = "provider" in input ? input : { provider: input };
      const label = member.label ?? `${member.provider.name}[${i}]`;
      return {
        provider: member.provider,
        index: i,
        weight: resolveWeight(member.weight, label),
        label,
      };
    });
    this.name = this.members[0]!.provider.name;
    const names = new Set(this.members.map((m) => m.provider.name));
    if (names.size > 1) {
      // model ids are routed verbatim to whichever member is picked, so mixing
      // providers in one pool is almost always a misconfiguration
      warnOnce(
        "pool-mixed-providers",
        `pool mixes providers (${[...names].join(", ")}); model ids are sent to whichever member is selected`,
      );
    }
    this.sequence = buildRotation(this.members.map((m) => m.weight));
    // every member appears at least once, so distinct count === members.length
    this.maxFailovers = Math.max(0, options.maxFailovers ?? this.members.length - 1);
    this.maxCooldownMs = options.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS;
    this.shouldFailover = options.shouldFailover ?? defaultShouldFailover;
    this.onFailover = options.onFailover;
    if (this.members.every((m) => typeof m.provider.embed === "function")) {
      this.embed = (o) =>
        this.runWithFailover(o, o.model, (p, opts) => p.embed!(opts));
    }
  }

  /**
   * Each member's last-known subscription rate-limit snapshot (see
   * {@link Provider.rateLimit}), by label — a live view of remaining quota per
   * account, for observability. The pool itself never acts on these: it only
   * cools a member on a real rate-limit error (see {@link recordCooldown}),
   * never on a soft-warning snapshot, so a member with quota left keeps serving.
   */
  rateLimits(): Array<{ label: string; rateLimit: RateLimitStatus | undefined }> {
    return this.members.map((m) => ({
      label: m.label,
      rateLimit: m.provider.rateLimit,
    }));
  }

  generate(options: GenerateOptions): Promise<GenerateResult> {
    return this.runWithFailover(options, options.model, (provider, opts) =>
      provider.generate(opts),
    );
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamEvent> {
    const model = options.model;
    const { attempts, allCooling } = this.plan(model);
    // Disable per-attempt retry when the pool orchestrates failover, or when
    // this is a last-ditch try while every member is already cooling — sitting
    // on a multi-hour subscription Retry-After would hang the request.
    const takeover = attempts.length > 1 || allCooling;
    let lastError: unknown;
    for (const [i, member] of attempts.entries()) {
      let yielded = false;
      try {
        const sub = takeover ? { ...options, retry: false as const } : options;
        for await (const event of member.provider.stream(sub)) {
          yielded = true;
          yield event;
        }
        return;
      } catch (error) {
        lastError = error;
        // once any event is out, switching would replay partial output
        if (yielded || !this.isFailover(error)) throw error;
        this.recordCooldown(member, model, error);
        const next = attempts[i + 1];
        if (!next) throw allCooling ? this.allCoolingError(model) : error;
        this.emitFailover(member, next, i, error);
      }
    }
    throw lastError;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Shared failover loop for unary calls (`generate`, `embed`). Tries members
   * in rotation order, switching on failover-class errors until one succeeds
   * or the attempts run out.
   */
  private async runWithFailover<
    O extends { retry?: Partial<RetryOptions> | false },
    R,
  >(
    options: O,
    model: string,
    invoke: (provider: Provider, opts: O) => Promise<R>,
  ): Promise<R> {
    const { attempts, allCooling } = this.plan(model);
    // See stream(): also force retry:false on an all-cooling last-ditch try.
    const takeover = attempts.length > 1 || allCooling;
    let lastError: unknown;
    for (const [i, member] of attempts.entries()) {
      try {
        return await invoke(
          member.provider,
          takeover ? { ...options, retry: false } : options,
        );
      } catch (error) {
        lastError = error;
        if (!this.isFailover(error)) throw error;
        this.recordCooldown(member, model, error);
        const next = attempts[i + 1];
        if (!next) throw allCooling ? this.allCoolingError(model) : error;
        this.emitFailover(member, next, i, error);
      }
    }
    throw lastError;
  }

  /**
   * Picks the members to try for one request to `model`. Walks the rotation from
   * the next round-robin slot, skipping members still cooling for this model;
   * the ready ones (capped by `maxFailovers + 1`) are returned. If *all* are
   * cooling, returns just the soonest-to-recover member as a last-ditch attempt
   * (`allCooling: true`) — it may have reset early.
   */
  private plan(model: string): { attempts: ResolvedMember[]; allCooling: boolean } {
    const start = this.cursor;
    this.cursor = (this.cursor + 1) % this.sequence.length;
    const rotation = [
      ...this.sequence.slice(start),
      ...this.sequence.slice(0, start),
    ];
    const seen = new Set<number>();
    const ready: ResolvedMember[] = [];
    const cooling: Array<{ member: ResolvedMember; until: number }> = [];
    for (const idx of rotation) {
      if (seen.has(idx)) continue;
      seen.add(idx);
      const member = this.members[idx];
      if (!member) continue;
      const until = this.coolingUntil(idx, model);
      if (until !== undefined) cooling.push({ member, until });
      else ready.push(member);
    }
    if (ready.length > 0) {
      return { attempts: ready.slice(0, this.maxFailovers + 1), allCooling: false };
    }
    cooling.sort((a, b) => a.until - b.until);
    return { attempts: cooling.slice(0, 1).map((c) => c.member), allCooling: true };
  }

  /**
   * The effective cooldown deadline for `(member, model)` — the later of the
   * member-wide cooldown (from an account-wide `resetAt`) and the per-model one
   * (from a relative `retryAfterMs`) — or `undefined` if neither is active.
   * Expired entries are thawed (deleted) as a side effect.
   */
  private coolingUntil(idx: number, model: string): number | undefined {
    const now = Date.now();
    let until: number | undefined;
    const memberUntil = this.memberCooldowns.get(idx);
    if (memberUntil !== undefined) {
      if (memberUntil > now) until = memberUntil;
      else this.memberCooldowns.delete(idx);
    }
    const key = cooldownKey(idx, model);
    const modelUntil = this.cooldowns.get(key);
    if (modelUntil !== undefined) {
      if (modelUntil > now) until = until === undefined ? modelUntil : Math.max(until, modelUntil);
      else this.cooldowns.delete(key);
    }
    return until;
  }

  /**
   * Records a cooldown for a member after a failover-class error. An account-wide
   * absolute `error.resetAt` (e.g. a subscription window reset) cools the *whole
   * member* across every model, honored exactly. Otherwise a relative
   * `error.retryAfterMs` cools just `(member, model)`, capped by `maxCooldownMs`
   * against an over-long/hostile header. A stale (past) `resetAt` falls through to
   * `retryAfterMs`. With neither signal the member is left in rotation (no blind
   * cooldown) — a transient fault isn't necessarily an account problem.
   */
  private recordCooldown(
    member: ResolvedMember,
    model: string,
    error: CardanError,
  ): void {
    const now = Date.now();
    if (error.resetAt != null && error.resetAt > now) {
      this.memberCooldowns.set(member.index, error.resetAt);
      return;
    }
    if (error.retryAfterMs != null) {
      const until = now + Math.min(error.retryAfterMs, this.maxCooldownMs);
      if (until > now) this.cooldowns.set(cooldownKey(member.index, model), until);
    }
  }

  /** Built when every member is cooling for `model` and the last-ditch try failed. */
  private allCoolingError(model: string): CardanError {
    let soonest: number | undefined;
    let label = "";
    for (const member of this.members) {
      const until = this.coolingUntil(member.index, model);
      if (until !== undefined && (soonest === undefined || until < soonest)) {
        soonest = until;
        label = member.label;
      }
    }
    const remaining = soonest === undefined ? undefined : Math.max(0, soonest - Date.now());
    const eta = remaining === undefined ? "unknown" : `${Math.ceil(remaining / 1000)}s`;
    return new CardanError(
      "rate_limit",
      `pool(${this.name}): all ${this.members.length} members are cooling down for model "${model}"; soonest recovery in ${eta} (member "${label}")`,
      { provider: this.name, retryAfterMs: remaining },
    );
  }

  private isFailover(error: unknown): error is CardanError {
    return (
      isCardanError(error) &&
      error.code !== "aborted" &&
      this.shouldFailover(error)
    );
  }

  private emitFailover(
    from: ResolvedMember,
    to: ResolvedMember,
    attempt: number,
    error: CardanError,
  ): void {
    if (this.onFailover) {
      this.onFailover({
        provider: this.name,
        fromLabel: from.label,
        toLabel: to.label,
        attempt,
        error,
      });
      return;
    }
    console.warn(
      `[cardan] pool(${this.name}): "${from.label}" failed (${error.code}: ${error.message}); switching to "${to.label}"`,
    );
  }
}

/** Cooldown map key for a `(member index, model)` pair. */
function cooldownKey(index: number, model: string): string {
  return `${index}:${model}`;
}

export function createPool(options: PoolOptions): PoolProvider {
  return new PoolProvider(options);
}
