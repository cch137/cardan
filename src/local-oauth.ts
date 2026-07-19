/**
 * Load CLI subscription credentials as ready-to-use providers with automatic
 * refresh write-back.
 *
 * Complements {@link detectCredentials} (read-only discovery / CLI output):
 * this module builds `AnthropicProvider` / `XAIOAuthProvider` instances and
 * persists rotated tokens back to the same files the official CLIs use.
 *
 * File I/O is injected via {@link LocalOAuthIO} (tests use fixtures; runtime
 * defaults come from dynamic `node:fs` / `node:os` imports — same pattern as
 * detect — so the static graph stays free of node builtins).
 */
import {
  detectAll,
  extractAnthropic,
  extractXAI,
  PROVIDERS,
  type DetectedCredential,
  type DetectIO,
  type ProviderSpec,
} from "./detect.js";
import { expandEnvFamily, readEnv } from "./env.js";
import { CardanError } from "./errors.js";
import {
  AnthropicProvider,
  type OAuthCredentials,
} from "./providers/anthropic.js";
import {
  XAIOAuthProvider,
  type XAIOAuthCredentials,
} from "./providers/xai-oauth.js";
import { createPool, type PoolBehavior, type PoolProvider } from "./pool.js";

/** Subscription prefixes that have a local CLI credential file. */
export type LocalOAuthPrefix = "anthropic" | "xai";

export interface LocalOAuthIO {
  readFile(path: string): string | undefined;
  /** Must throw on failure — silent no-ops lose rotated refresh tokens. */
  writeFile(path: string, contents: string): void;
}

interface LocalOAuthMemberBase {
  /** Ops / pool label (never a secret). */
  label: string;
  /** Absolute credential path when file-backed. */
  path?: string;
  /** True when a refresh token is present (proactive + on-401 refresh). */
  canRefresh: boolean;
}

/** File- or env-backed subscription member (discriminated on {@link prefix}). */
export type LocalOAuthMember =
  | (LocalOAuthMemberBase & {
    prefix: "anthropic";
    provider: AnthropicProvider;
  })
  | (LocalOAuthMemberBase & {
    prefix: "xai";
    provider: XAIOAuthProvider;
  });

/** A bare access token to merge with file-backed members (e.g. from env). */
export interface LocalOAuthTokenInput {
  prefix: LocalOAuthPrefix;
  accessToken: string;
  label?: string;
}

export interface LoadLocalOAuthOptions {
  /** Home directory to scan (default: runtime `os.homedir()`). */
  home?: string;
  /** Which prefixes to load; default both. */
  prefixes?: LocalOAuthPrefix[];
  /**
   * Scan CLI credential files under `home` (default `true`). Set `false` to
   * use only {@link env} / {@link tokens} (e.g. long-lived setup-tokens).
   */
  files?: boolean;
  /** Injected I/O (tests). Runtime defaults use `node:fs`. */
  io?: Partial<LocalOAuthIO>;
  /**
   * Extra bare access tokens (no refresh), typically from env. Deduped against
   * file credentials by access-token value — **file-backed wins** when equal
   * (keeps the refreshable member).
   */
  tokens?: LocalOAuthTokenInput[];
  /**
   * Bare env tokens to merge (no refresh). Each **base** name expands to every
   * set sibling in the process env: `BASE`, `BASE1`, `BASE2`, … `BASE10`, …
   * (see {@link expandEnvFamily}). Prefix is inferred from the name
   * (`CLAUDE_CODE_*` → anthropic, `GROK_BUILD_*` → xai).
   *
   * - `true` (default): use each loaded prefix's standard base
   *   (`CLAUDE_CODE_OAUTH_TOKEN` / `GROK_BUILD_OAUTH_TOKEN`).
   * - `false`: do not read env tokens.
   * - `string` / `string[]`: treat each entry as a base family name.
   */
  env?: boolean | string | string[];
}

/** Default env base names for the given local-oauth prefixes. */
function defaultEnvBases(prefixes: ReadonlySet<LocalOAuthPrefix>): string[] {
  const bases: string[] = [];
  for (const spec of PROVIDERS) {
    const prefix = prefixForSpec(spec);
    if (prefix && prefixes.has(prefix)) bases.push(spec.envVar);
  }
  return bases;
}

/** Resolve {@link LoadLocalOAuthOptions.env} into concrete env var names. */
function resolveEnvNames(
  env: boolean | string | string[] | undefined,
  prefixes: ReadonlySet<LocalOAuthPrefix>,
): string[] {
  if (env === false) return [];
  const bases =
    env === undefined || env === true
      ? defaultEnvBases(prefixes)
      : typeof env === "string"
      ? [env]
      : env;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const base of bases) {
    for (const name of expandEnvFamily(base)) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function prefixForSpec(spec: ProviderSpec): LocalOAuthPrefix | undefined {
  if (spec.envVar.startsWith("CLAUDE_CODE_")) return "anthropic";
  if (spec.envVar.startsWith("GROK_BUILD_")) return "xai";
  return undefined;
}

function prefixForEnvName(name: string): LocalOAuthPrefix | undefined {
  if (name.startsWith("CLAUDE_CODE_")) return "anthropic";
  if (name.startsWith("GROK_BUILD_")) return "xai";
  return undefined;
}

function labelFromCred(cred: DetectedCredential, fallback: string): string {
  for (const [key, value] of cred.info) {
    if (key === "account" || key === "subscription") {
      // "cch137 <email>" → "cch137"; "pro · tier" kept as-is when no email.
      const name = value.split(/\s+</)[0]?.trim();
      if (name) return name;
    }
  }
  return fallback;
}

/**
 * Shape-based write-back for Claude Code / Grok CLI credential files.
 * Matches the entry by its current access token field, updates in place,
 * preserves unrelated keys. Throws when the file or entry cannot be updated
 * so {@link OAuthTokenManager} surfaces a persistence warning.
 */
export function persistLocalOAuth(
  path: string,
  prefix: LocalOAuthPrefix,
  previousAccessToken: string,
  next: { accessToken: string; refreshToken: string; expiresAt: number | null },
  io: LocalOAuthIO,
): void {
  const raw = io.readFile(path);
  if (raw === undefined) {
    throw new CardanError(
      "auth",
      `local oauth: cannot read credential file for write-back (${path})`,
      { provider: prefix },
    );
  }
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new CardanError(
      "auth",
      `local oauth: credential file is not valid JSON (${path}): ${cause}`,
      { provider: prefix },
    );
  }
  if (!isObject(root)) {
    throw new CardanError(
      "auth",
      `local oauth: credential file root is not an object (${path})`,
      { provider: prefix },
    );
  }

  let updated = false;
  const visit = (entry: Record<string, unknown>): boolean => {
    if (prefix === "anthropic") {
      if (entry.accessToken !== previousAccessToken) return false;
      entry.accessToken = next.accessToken;
      entry.refreshToken = next.refreshToken;
      if (next.expiresAt != null) entry.expiresAt = next.expiresAt;
      return true;
    }
    // xai — Grok CLI uses `key` / `refresh_token` / `expires_at` (ISO).
    if (entry.key !== previousAccessToken) return false;
    entry.key = next.accessToken;
    entry.refresh_token = next.refreshToken;
    if (next.expiresAt != null) {
      entry.expires_at = new Date(next.expiresAt).toISOString();
      if ("exp" in entry) entry.exp = Math.floor(next.expiresAt / 1000);
    }
    return true;
  };

  // Anthropic: entry may be the root or one level deep (`claudeAiOauth`).
  // xAI: entries are values under a scope key.
  if (prefix === "anthropic") {
    if (visit(root)) {
      updated = true;
    } else {
      for (const value of Object.values(root)) {
        if (isObject(value) && visit(value)) {
          updated = true;
          break;
        }
      }
    }
  } else {
    for (const value of Object.values(root)) {
      if (isObject(value) && visit(value)) {
        updated = true;
        break;
      }
    }
  }

  if (!updated) {
    throw new CardanError(
      "auth",
      `local oauth: no credential entry matched the access token in ${path}`,
      { provider: prefix },
    );
  }

  io.writeFile(path, `${JSON.stringify(root, null, 2)}\n`);
}

/**
 * The access token the credential file currently holds, shared between the
 * write-back ({@link makeOnRefresh}) and reload ({@link makeReload}) closures
 * of one file member: write-back matches the file entry by this token, and a
 * reload that adopts an externally rotated credential must move it in step or
 * the next write-back misses the entry and the rotation is lost.
 */
interface HeldToken {
  accessToken: string;
}

function makeOnRefresh(
  path: string,
  prefix: LocalOAuthPrefix,
  held: HeldToken,
  io: LocalOAuthIO,
): (c: {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}) => void {
  return (c) => {
    // Refresh always yields a refresh token string in practice; fall back to
    // empty only so a malformed response still fails at persist/match rather
    // than silently skipping write-back.
    const refreshToken = c.refreshToken ?? "";
    persistLocalOAuth(
      path,
      prefix,
      held.accessToken,
      {
        accessToken: c.accessToken,
        refreshToken,
        expiresAt: c.expiresAt,
      },
      io,
    );
    held.accessToken = c.accessToken;
  };
}

/**
 * Re-read the credential file (same shape-based extraction as detect) so
 * {@link OAuthTokenManager} can adopt tokens rotated by the official CLI
 * instead of refreshing with a rotated-out refresh token. Returns `undefined`
 * on a missing/unparseable file — the in-memory credentials stay in effect.
 */
function makeReload(
  path: string,
  prefix: LocalOAuthPrefix,
  held: HeldToken,
  io: LocalOAuthIO,
): () => {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number | null;
} | undefined {
  const extract = prefix === "anthropic" ? extractAnthropic : extractXAI;
  return () => {
    const raw = io.readFile(path);
    if (raw === undefined) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const cred = extract(json);
    if (!cred) return undefined;
    // The file entry now carries this token; keep write-back matching it.
    held.accessToken = cred.accessToken;
    return {
      accessToken: cred.accessToken,
      refreshToken: cred.refreshToken,
      expiresAt: cred.expiresAt ?? null,
    };
  };
}

function memberFromFile(
  prefix: LocalOAuthPrefix,
  cred: DetectedCredential,
  path: string,
  io: LocalOAuthIO,
  labelFallback: string,
): LocalOAuthMember {
  const label = labelFromCred(cred, labelFallback);
  const canRefresh = Boolean(cred.refreshToken);
  const held: HeldToken = { accessToken: cred.accessToken };
  const onRefresh = canRefresh
    ? makeOnRefresh(path, prefix, held, io)
    : undefined;
  const reload = makeReload(path, prefix, held, io);

  if (prefix === "anthropic") {
    const credentials: OAuthCredentials = {
      accessToken: cred.accessToken,
      refreshToken: cred.refreshToken,
      expiresAt: cred.expiresAt ?? null,
    };
    return {
      prefix,
      label,
      path,
      canRefresh,
      provider: new AnthropicProvider({
        oauth: { credentials, onRefresh, reload },
      }),
    };
  }

  const credentials: XAIOAuthCredentials = {
    accessToken: cred.accessToken,
    refreshToken: cred.refreshToken,
    expiresAt: cred.expiresAt ?? null,
  };
  return {
    prefix,
    label,
    path,
    canRefresh,
    provider: new XAIOAuthProvider({
      credentials,
      onRefresh,
      reload,
      // Refresh against the issuer/client the credential was minted with
      // (enterprise IdPs, future client rotations); defaults cover `grok login`.
      ...(cred.oidcIssuer ? { issuer: cred.oidcIssuer } : {}),
      ...(cred.oidcClientId ? { clientId: cred.oidcClientId } : {}),
    }),
  };
}

function memberFromBareToken(
  prefix: LocalOAuthPrefix,
  accessToken: string,
  label: string,
): LocalOAuthMember {
  if (prefix === "anthropic") {
    return {
      prefix,
      label,
      canRefresh: false,
      provider: new AnthropicProvider({ oauth: accessToken }),
    };
  }
  return {
    prefix,
    label,
    canRefresh: false,
    provider: new XAIOAuthProvider({
      credentials: { accessToken },
    }),
  };
}

async function resolveIO(
  options: LoadLocalOAuthOptions,
): Promise<{ home: string; io: LocalOAuthIO }> {
  let home = options.home;
  let readFile = options.io?.readFile;
  let writeFile = options.io?.writeFile;

  if (home === undefined || readFile === undefined || writeFile === undefined) {
    try {
      const [fs, os] = await Promise.all([import("node:fs"), import("node:os")]);
      home ??= os.homedir();
      readFile ??= (path) => {
        try {
          return fs.readFileSync(path, "utf8");
        } catch {
          return undefined;
        }
      };
      writeFile ??= (path, contents) => {
        fs.writeFileSync(path, contents, "utf8");
      };
    } catch {
      // Non-node runtime without injected IO: no file access.
    }
  }

  return {
    home: home ?? "",
    io: {
      readFile: readFile ?? (() => undefined),
      writeFile: writeFile ??
        ((path) => {
          throw new CardanError(
            "auth",
            `local oauth: no writeFile available to persist credentials (${path})`,
          );
        }),
    },
  };
}

/**
 * Load subscription OAuth members from CLI credential files (with refresh
 * write-back) plus optional bare env / explicit tokens.
 *
 * Dedupes by access-token value: file-backed members are inserted first so
 * they beat a matching bare env token (keeps the refreshable member).
 */
export async function loadLocalOAuth(
  options: LoadLocalOAuthOptions = {},
): Promise<LocalOAuthMember[]> {
  const { home, io } = await resolveIO(options);
  const want = new Set<LocalOAuthPrefix>(
    options.prefixes ?? ["anthropic", "xai"],
  );

  const members: LocalOAuthMember[] = [];
  const seen = new Set<string>();
  const add = (accessToken: string, member: LocalOAuthMember) => {
    if (!accessToken || seen.has(accessToken)) return;
    seen.add(accessToken);
    members.push(member);
  };

  if (options.files !== false && home) {
    const detectIo: DetectIO = { home, readFile: io.readFile };
    for (const d of detectAll(detectIo)) {
      const prefix = prefixForSpec(d.spec);
      if (!prefix || !want.has(prefix) || !d.cred || !d.path) continue;
      add(
        d.cred.accessToken,
        memberFromFile(prefix, d.cred, d.path, io, d.spec.cliCommand),
      );
    }
  }

  for (const name of resolveEnvNames(options.env, want)) {
    const token = readEnv(name)?.trim();
    if (!token) continue;
    const prefix = prefixForEnvName(name);
    if (!prefix || !want.has(prefix)) continue;
    add(token, memberFromBareToken(prefix, token, name));
  }

  for (const t of options.tokens ?? []) {
    const token = t.accessToken.trim();
    if (!token || !want.has(t.prefix)) continue;
    add(token, memberFromBareToken(t.prefix, token, t.label ?? t.prefix));
  }

  return members;
}

/**
 * Members for one prefix only (convenience filter over {@link loadLocalOAuth}).
 */
export async function loadLocalOAuthPrefix(
  prefix: "anthropic",
  options?: Omit<LoadLocalOAuthOptions, "prefixes">,
): Promise<Array<Extract<LocalOAuthMember, { prefix: "anthropic" }>>>;
export async function loadLocalOAuthPrefix(
  prefix: "xai",
  options?: Omit<LoadLocalOAuthOptions, "prefixes">,
): Promise<Array<Extract<LocalOAuthMember, { prefix: "xai" }>>>;
export async function loadLocalOAuthPrefix(
  prefix: LocalOAuthPrefix,
  options: Omit<LoadLocalOAuthOptions, "prefixes"> = {},
): Promise<LocalOAuthMember[]> {
  return loadLocalOAuth({ ...options, prefixes: [prefix] });
}

/**
 * Build a {@link PoolProvider} over local OAuth members for one prefix.
 * Returns `undefined` when there are no members. Always pools (including a
 * single member) so cooldown and `rateLimits()` are uniform.
 */
export async function localOAuthPool(
  prefix: LocalOAuthPrefix,
  options: Omit<LoadLocalOAuthOptions, "prefixes"> & PoolBehavior = {},
): Promise<PoolProvider | undefined> {
  const { maxFailovers, shouldFailover, maxCooldownMs, onFailover, ...loadOpts } =
    options;
  const members = await loadLocalOAuth({ ...loadOpts, prefixes: [prefix] });
  if (members.length === 0) return undefined;
  return createPool({
    members: members.map((m) => ({ provider: m.provider, label: m.label })),
    maxFailovers,
    shouldFailover,
    maxCooldownMs,
    onFailover,
  });
}
