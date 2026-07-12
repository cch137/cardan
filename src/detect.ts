/**
 * `cardan detect` data layer — find local AI subscription credentials
 * (Claude Code, Grok CLI). This module is pure data only; text rendering and
 * the ready-to-paste env block live in the CLI layer (`cli.ts`).
 *
 * Core logic is pure — file access is injected via {@link DetectIO} so tests
 * run on fixtures. {@link detectCredentials} adds runtime defaults through
 * dynamic `node:fs`/`node:os` imports (statically the library stays free of
 * node builtins, and non-node runtimes degrade to env-only detection).
 *
 * Matching is shape-based, not key-based: both CLIs key their credential
 * object under names that have already changed across versions (the Grok CLI
 * scope/audience id, Anthropic's `claudeAiOauth`), so detection scans JSON
 * values for an object carrying an access token instead of hardcoding keys.
 *
 * Detect never refreshes tokens: refresh tokens rotate on use, and refreshing
 * outside the official CLIs would invalidate the credentials they have stored.
 */
import { readEnv } from "./env.js";

/**
 * A provider's file search order: its own known names first, then a shared pool
 * of names either CLI might adopt in future. Deduped so no name is checked twice.
 */
export function candidateFileNames(ownNames: readonly string[]): string[] {
  const shared = [".credentials.json", "credentials.json", ".auth.json", "auth.json"];
  return [...new Set([...ownNames, ...shared])];
}

export interface DetectedCredential {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms; undefined = unknown (no expiry claim in the file). */
  expiresAt?: number;
  /** Epoch ms expiry of the refresh token, when the file reports one. */
  refreshExpiresAt?: number;
  /** Provider-specific display rows (label, value), e.g. subscription tier. */
  info: Array<[string, string]>;
}

export interface ProviderSpec {
  /** Section heading, e.g. `Anthropic (Claude Code)`. */
  title: string;
  /** Official CLI command that refreshes the credential, e.g. `claude`. */
  cliCommand: string;
  /** Credential directory relative to home, e.g. `.claude`. */
  dir: string;
  /** Known file names for this provider, current first. */
  ownNames: readonly string[];
  /** Env var name used to label this provider's token in the `.env` output. */
  envVar: string;
  /** Pulls a credential out of parsed JSON, or undefined if shape mismatch. */
  extract(json: unknown): DetectedCredential | undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Epoch ms from a number (already ms) or a parseable date string. */
function epochMs(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return ms;
  }
  return undefined;
}

/**
 * Claude Code stores `{ claudeAiOauth: { accessToken, refreshToken, expiresAt,
 * refreshTokenExpiresAt, subscriptionType, rateLimitTier, ... } }`. The wrapper
 * key may be renamed, so accept any object (root or one level deep) with a
 * string `accessToken`.
 */
export function extractAnthropic(json: unknown): DetectedCredential | undefined {
  if (!isObject(json)) return undefined;
  for (const entry of [json, ...Object.values(json)]) {
    if (!isObject(entry)) continue;
    const token = entry.accessToken;
    if (typeof token !== "string" || !token) continue;
    const info: Array<[string, string]> = [];
    const tier = [entry.subscriptionType, entry.rateLimitTier].filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    if (tier.length) info.push(["subscription", tier.join(" · ")]);
    return {
      accessToken: token,
      refreshToken:
        typeof entry.refreshToken === "string" && entry.refreshToken
          ? entry.refreshToken
          : undefined,
      expiresAt: epochMs(entry.expiresAt),
      refreshExpiresAt: epochMs(entry.refreshTokenExpiresAt),
      info,
    };
  }
  return undefined;
}

/**
 * The Grok CLI stores `{ "<scope>": { key, refresh_token, expires_at, email,
 * first_name, ... } }` where `<scope>` embeds an audience UUID that can change,
 * so scan values for an object with a string `key`. If several entries match,
 * keep the one expiring last (unknown expiry counts as freshest).
 */
export function extractXAI(json: unknown): DetectedCredential | undefined {
  if (!isObject(json)) return undefined;
  let best: { cred: DetectedCredential; expiresAt: number } | undefined;
  for (const entry of Object.values(json)) {
    if (!isObject(entry)) continue;
    const token = entry.key;
    if (typeof token !== "string" || !token) continue;
    const info: Array<[string, string]> = [];
    const name = typeof entry.first_name === "string" ? entry.first_name : "";
    const email = typeof entry.email === "string" ? entry.email : "";
    const account = [name, email && `<${email}>`].filter(Boolean).join(" ");
    if (account) info.push(["account", account]);
    const cred: DetectedCredential = {
      accessToken: token,
      refreshToken:
        typeof entry.refresh_token === "string" && entry.refresh_token
          ? entry.refresh_token
          : undefined,
      expiresAt: epochMs(entry.expires_at),
      info,
    };
    const exp = cred.expiresAt ?? Infinity;
    if (!best || exp > best.expiresAt) best = { cred, expiresAt: exp };
  }
  return best?.cred;
}

export const PROVIDERS: ProviderSpec[] = [
  {
    title: "Anthropic (Claude Code)",
    cliCommand: "claude",
    dir: ".claude",
    ownNames: [".credentials.json"],
    envVar: "CLAUDE_CODE_OAUTH_TOKEN",
    extract: extractAnthropic,
  },
  {
    title: "xAI (Grok CLI)",
    cliCommand: "grok",
    dir: ".grok",
    ownNames: ["auth.json", "credentials.json"],
    envVar: "GROK_BUILD_OAUTH_TOKEN",
    extract: extractXAI,
  },
];

export interface DetectIO {
  /** Absolute home directory path. */
  home: string;
  /** File contents, or undefined when missing/unreadable. */
  readFile(path: string): string | undefined;
}

export interface ProviderDetection {
  spec: ProviderSpec;
  /** Display path of the matched file, e.g. `~/.grok/auth.json`. */
  file?: string;
  cred?: DetectedCredential;
}

/** A home directory to scan, with the account it belongs to. */
export interface UserHome {
  /** Account display name, e.g. `alice` or `root`. */
  user: string;
  /** Absolute home directory. */
  home: string;
  /** True for the account running detect — env vars apply only here. */
  current: boolean;
}

export interface UserDetection extends UserHome {
  providers: ProviderDetection[];
}

/** IO + machine layout for {@link detectUsers}; runtime defaults via node. */
export interface UsersIO {
  /** Home of the account running detect. */
  currentHome: string;
  /** Display name of that account. */
  currentUser: string;
  /** File contents, or undefined when missing/unreadable (silent skip). */
  readFile(path: string): string | undefined;
  /** Directory entries, or undefined when missing/unreadable (silent skip). */
  readDir(path: string): string[] | undefined;
  /** Parent dirs each holding per-user home folders, e.g. `["/home"]`. */
  userRoots: string[];
  /** Extra absolute homes to include, e.g. `["/root"]`. */
  extraHomes: string[];
  /** Compare home paths case-insensitively (Windows). */
  caseInsensitivePaths?: boolean;
}

export function detectProvider(spec: ProviderSpec, io: DetectIO): ProviderDetection {
  let file: string | undefined;
  let cred: DetectedCredential | undefined;
  for (const name of candidateFileNames(spec.ownNames)) {
    const raw = io.readFile(`${io.home}/${spec.dir}/${name}`);
    if (raw === undefined) continue;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      continue;
    }
    const extracted = spec.extract(json);
    if (extracted) {
      file = `~/${spec.dir}/${name}`;
      cred = extracted;
      break;
    }
  }
  return { spec, file, cred };
}

export function detectAll(io: DetectIO): ProviderDetection[] {
  return PROVIDERS.map((spec) => detectProvider(spec, io));
}

/** Last path segment, tolerant of both `/` and `\` separators. */
function baseName(p: string): string {
  const parts = p.split(/[/\\]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : p;
}

/** Strip trailing separators. */
function normHome(p: string): string {
  return p.replace(/[/\\]+$/, "");
}

/**
 * All home directories to scan: the current account first, then every entry
 * under each `userRoots` dir, then `extraHomes` (e.g. `/root`). Deduped by
 * path (separator- and, on Windows, case-insensitive); the current account
 * always appears even if its home is empty.
 */
export function enumerateHomes(io: UsersIO): UserHome[] {
  const homes: UserHome[] = [];
  const seen = new Set<string>();
  const keyOf = (p: string) => {
    const k = p.replace(/\\/g, "/");
    return io.caseInsensitivePaths ? k.toLowerCase() : k;
  };
  const push = (home: string, user: string, current: boolean) => {
    const norm = normHome(home);
    const key = keyOf(norm);
    if (seen.has(key)) return;
    seen.add(key);
    homes.push({ home: norm, user, current });
  };
  push(io.currentHome, io.currentUser, true);
  for (const root of io.userRoots) {
    for (const entry of io.readDir(root) ?? []) push(`${root}/${entry}`, entry, false);
  }
  for (const home of io.extraHomes) push(home, baseName(home), false);
  return homes;
}

/**
 * Scan every discoverable account's home for credentials (the multi-user
 * counterpart of {@link detectAll}). Accounts with no credential are dropped,
 * except the current account which is always kept. Unreadable homes/files are
 * skipped silently (no permission → no error).
 */
export function detectUsers(io: UsersIO): UserDetection[] {
  const results: UserDetection[] = [];
  for (const h of enumerateHomes(io)) {
    const providers = detectAll({ home: h.home, readFile: io.readFile });
    if (h.current || providers.some((p) => p.cred)) {
      results.push({ ...h, providers });
    }
  }
  return results;
}

/** Overrides for {@link detectCredentials}; anything omitted uses runtime defaults. */
export type DetectOptions = Partial<DetectIO>;

/**
 * Runtime credential detection — the programmatic counterpart of
 * `cardan detect`. Scans the well-known credential files and returns structured
 * results. Independent of environment variables. Never throws for missing
 * capabilities: on runtimes without `node:fs`/`node:os` (or with an
 * unresolvable home) it returns empty detections rather than failing.
 */
export async function detectCredentials(
  options: DetectOptions = {},
): Promise<ProviderDetection[]> {
  let home = options.home;
  let readFile = options.readFile;
  if (home === undefined || readFile === undefined) {
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
    } catch {
      // Non-node runtime: no file access; detection yields nothing.
    }
  }
  return detectAll({
    home: home ?? "",
    readFile: home ? (readFile ?? (() => undefined)) : () => undefined,
  });
}

/** Where per-user homes live, per OS. Root gets an explicit entry (off `/home`). */
function defaultHomeLayout(
  platform: string,
): { userRoots: string[]; extraHomes: string[] } {
  switch (platform) {
    case "linux":
      return { userRoots: ["/home"], extraHomes: ["/root"] };
    case "darwin":
      return { userRoots: ["/Users"], extraHomes: ["/var/root"] };
    case "win32": {
      const drive = normHome(readEnv("SystemDrive") || "C:");
      return { userRoots: [`${drive}/Users`], extraHomes: [] };
    }
    default:
      return { userRoots: [], extraHomes: [] };
  }
}

/**
 * Runtime multi-user detection — scans every account's home this process can
 * read (Linux `/home/*` + `/root`, macOS `/Users/*` + `/var/root`, Windows
 * `%SystemDrive%\Users\*`). Missing capabilities and permission errors degrade
 * silently; the current account is always included. Runs on Windows via
 * `os.homedir()`.
 */
export async function detectAllUsers(
  options: Partial<UsersIO> = {},
): Promise<UserDetection[]> {
  const proc = (globalThis as { process?: { platform?: string } }).process;
  const platform = proc?.platform ?? "";
  let { currentHome, readFile, readDir } = options;
  if (currentHome === undefined || readFile === undefined || readDir === undefined) {
    try {
      const [fs, os] = await Promise.all([import("node:fs"), import("node:os")]);
      currentHome ??= os.homedir();
      readFile ??= (path) => {
        try {
          return fs.readFileSync(path, "utf8");
        } catch {
          return undefined;
        }
      };
      readDir ??= (path) => {
        try {
          return fs.readdirSync(path);
        } catch {
          return undefined;
        }
      };
    } catch {
      // Non-node runtime: no fs. The current account is still returned (empty).
    }
  }
  const hasFs = currentHome !== undefined && readFile !== undefined;
  const layout = defaultHomeLayout(platform);
  return detectUsers({
    currentHome: currentHome ?? "",
    currentUser:
      options.currentUser ||
      readEnv("USER") ||
      readEnv("USERNAME") ||
      readEnv("LOGNAME") ||
      (currentHome ? baseName(currentHome) : "") ||
      "current",
    readFile: readFile ?? (() => undefined),
    readDir: readDir ?? (() => undefined),
    userRoots: options.userRoots ?? (hasFs ? layout.userRoots : []),
    extraHomes: options.extraHomes ?? (hasFs ? layout.extraHomes : []),
    caseInsensitivePaths: options.caseInsensitivePaths ?? platform === "win32",
  });
}

/**
 * Whether any credential file was found — drives the CLI exit code. Pure data;
 * text rendering lives in the CLI layer (`cli.ts`).
 */
export function hasAnyCredential(detections: ProviderDetection[]): boolean {
  return detections.some((d) => d.cred);
}

/** True when the credential carries an expiry that has already passed. */
export function isExpired(cred: DetectedCredential, now = Date.now()): boolean {
  return cred.expiresAt !== undefined && now >= cred.expiresAt;
}
