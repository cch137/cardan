#!/usr/bin/env node
/**
 * cardan CLI. Owns everything presentational: turning the pure detection data
 * from `detect.ts` into human-readable text and the ready-to-paste env block,
 * plus argv parsing and exit codes. `detect.ts` stays pure data.
 *
 * The render functions are exported and unit-tested; the CLI body only runs
 * when this file is invoked directly (see {@link invokedAsCli}), so importing
 * it from tests has no side effects.
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  detectAllUsers,
  detectCredentials,
  hasAnyCredential,
  isExpired,
  PROVIDERS,
  type DetectedCredential,
  type ProviderDetection,
  type UserDetection,
} from "./detect.js";

// --- rendering ----------------------------------------------------------

/** `2026-07-12 16:11 UTC` */
function fmtTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function row(label: string, value: string): string {
  return `  ${label.padEnd(15)}${value}`;
}

/** The display rows for one provider (title excluded): file/info/tokens/env. */
function providerRows(d: ProviderDetection, now: number): string[] {
  const out: string[] = [];
  if (d.cred) {
    out.push(row("file", d.file ?? ""));
    for (const [label, value] of d.cred.info) out.push(row(label, value));
    out.push(
      row(
        "access token",
        d.cred.expiresAt === undefined
          ? "present"
          : isExpired(d.cred, now)
            ? `EXPIRED ${fmtTime(d.cred.expiresAt)}`
            : `valid · expires ${fmtTime(d.cred.expiresAt)}`,
      ),
    );
    out.push(
      row(
        "refresh token",
        d.cred.refreshToken
          ? d.cred.refreshExpiresAt !== undefined
            ? `present · expires ${fmtTime(d.cred.refreshExpiresAt)}`
            : "present"
          : "none",
      ),
    );
  } else {
    out.push(row("file", `not found (~/${d.spec.dir}/)`));
  }
  return out;
}

/** Render detections for a single account. `found` drives the exit code. */
export function renderDetections(
  detections: ProviderDetection[],
  now = Date.now(),
): { text: string; found: boolean } {
  const lines: string[] = [];
  const envBlock: string[] = [];
  for (const d of detections) {
    lines.push(d.spec.title, ...providerRows(d, now), "");
    if (d.cred) {
      if (isExpired(d.cred, now)) {
        envBlock.push(
          `# expired — run \`${d.spec.cliCommand}\` to refresh, then re-run detect`,
        );
      } else if (d.cred.expiresAt !== undefined) {
        // The env path sends this access token verbatim and never refreshes it
        // (see docs/cli.md), so it goes stale at expiry. Flag when — and, when
        // the provider has one, how to get a long-lived token instead.
        const hint = d.spec.durableHint ? ` — ${d.spec.durableHint}` : "";
        envBlock.push(`# access token expires ${fmtTime(d.cred.expiresAt)}${hint}`);
      }
      envBlock.push(`${d.spec.envVar}=${d.cred.accessToken}`);
    }
  }
  if (envBlock.length) {
    lines.push("# .env — cardan reads these automatically", ...envBlock);
  } else {
    lines.push("No credentials found.");
  }
  return { text: lines.join("\n") + "\n", found: hasAnyCredential(detections) };
}

/**
 * Combined env block across accounts. When a provider yields tokens from more
 * than one account, the env vars are numbered (`GROK_BUILD_OAUTH_TOKEN1`, …)
 * and each line is annotated with its source account; cardan reads the
 * unsuffixed name, so keep one and drop the number.
 */
function combinedEnvBlock(users: UserDetection[], now: number): string[] {
  const out: string[] = [];
  let numbered = false;
  for (const spec of PROVIDERS) {
    const hits: Array<{ user: string; cred: DetectedCredential }> = [];
    for (const u of users) {
      const d = u.providers.find((p) => p.spec === spec);
      if (d?.cred) hits.push({ user: u.user, cred: d.cred });
    }
    hits.forEach(({ user, cred }, i) => {
      const name = hits.length > 1 ? `${spec.envVar}${i + 1}` : spec.envVar;
      if (hits.length > 1) numbered = true;
      const note = isExpired(cred, now)
        ? `  # from ${user} (EXPIRED — run \`${spec.cliCommand}\`)`
        : `  # from ${user}`;
      out.push(`${name}=${cred.accessToken}${note}`);
    });
  }
  if (!out.length) return [];
  const header = ["# .env — cardan reads these automatically"];
  if (numbered) header.push("# (numbered = one per account; keep one, drop the suffix)");
  return [...header, ...out];
}

/** Render multi-account detections (`detectAllUsers`) as CLI output. */
export function renderUsers(
  users: UserDetection[],
  now = Date.now(),
): { text: string; found: boolean } {
  const lines: string[] = [];
  for (const u of users) {
    const tag = u.current ? " (current user)" : "";
    lines.push(`# ${u.user}${tag} — ${u.home || "(unknown home)"}`);
    for (const d of u.providers) {
      lines.push(`  ${d.spec.title}`);
      for (const r of providerRows(d, now)) lines.push(`  ${r}`);
      lines.push("");
    }
  }
  const envBlock = combinedEnvBlock(users, now);
  if (envBlock.length) {
    lines.push(...envBlock);
  } else {
    lines.push("No credentials found.");
  }
  return { text: lines.join("\n"), found: users.some((u) => hasAnyCredential(u.providers)) };
}

// --- CLI shell ----------------------------------------------------------

async function runDetect(allUsers: boolean): Promise<number> {
  const { text, found } = allUsers
    ? renderUsers(await detectAllUsers())
    : renderDetections(await detectCredentials());
  console.log(text);
  return found ? 0 : 1;
}

function version(): string {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  return pkg.version;
}

const HELP = `cardan — zero-dependency LLM SDK

Usage:
  cardan detect              find this account's AI subscription credentials
  cardan detect --all-users  scan every account's home this process can read

Options:
  -a, --all-users   scan all users' homes (Linux /home + /root, macOS /Users,
                    Windows \\Users); unreadable homes are skipped silently
  -h, --help        show this help
  -v, --version     print version`;

async function main(): Promise<void> {
  const command = process.argv[2];
  const flags = process.argv.slice(3);
  const wantsHelp = flags.includes("--help") || flags.includes("-h");
  const allUsers = flags.includes("--all-users") || flags.includes("-a");
  switch (command) {
    case "detect":
      if (wantsHelp) {
        console.log(HELP);
        return;
      }
      process.exit(await runDetect(allUsers));
      break;
    case "-v":
    case "--version":
      console.log(version());
      break;
    case "-h":
    case "--help":
    case undefined:
      console.log(HELP);
      break;
    default:
      console.error(`unknown command: ${command}\n`);
      console.error(HELP);
      process.exit(1);
  }
}

/**
 * True when this module is the process entry point (run as the `cardan` bin),
 * not merely imported (e.g. by tests). Resolves symlinks so the npm bin shim
 * still matches `import.meta.url`.
 */
function invokedAsCli(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsCli()) await main();
