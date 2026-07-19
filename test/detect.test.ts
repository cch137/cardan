import { test } from "node:test";
import assert from "node:assert/strict";

import {
  candidateFileNames,
  detectAll,
  detectProvider,
  detectUsers,
  enumerateHomes,
  extractAnthropic,
  extractXAI,
  PROVIDERS,
  type DetectIO,
  type UsersIO,
} from "../src/detect.js";
import { renderDetections, renderUsers } from "../src/cli.js";
import { detectAllUsers, detectCredentials } from "../src/index.js";

const NOW = Date.parse("2026-07-12T12:00:00Z");

const anthropicFile = JSON.stringify({
  claudeAiOauth: {
    accessToken: "sk-ant-oat01-abc",
    refreshToken: "sk-ant-ort01-def",
    expiresAt: NOW + 3_600_000,
    refreshTokenExpiresAt: NOW + 86_400_000,
    scopes: ["user:inference"],
    subscriptionType: "pro",
    rateLimitTier: "default_claude_ai",
  },
  organizationUuid: "org-uuid",
});

const grokFile = JSON.stringify({
  "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
    key: "eyJ0.grok.token",
    auth_mode: "oidc",
    email: "user@example.com",
    first_name: "chee",
    refresh_token: "grok-refresh",
    expires_at: new Date(NOW + 7_200_000).toISOString(),
    oidc_issuer: "https://auth.x.ai",
    oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
  },
});

function io(files: Record<string, string>): DetectIO {
  return {
    home: "/home/u",
    readFile: (path) => files[path],
  };
}

const [anthropicSpec, xaiSpec] = PROVIDERS as [
  (typeof PROVIDERS)[number],
  (typeof PROVIDERS)[number],
];

test("candidateFileNames: own names first, shared pool deduped", () => {
  assert.deepEqual(candidateFileNames(anthropicSpec.ownNames), [
    ".credentials.json",
    "credentials.json",
    ".auth.json",
    "auth.json",
  ]);
  assert.deepEqual(candidateFileNames(xaiSpec.ownNames), [
    "auth.json",
    "credentials.json",
    ".credentials.json",
    ".auth.json",
  ]);
});

test("extractAnthropic: current claudeAiOauth shape", () => {
  const cred = extractAnthropic(JSON.parse(anthropicFile));
  assert.ok(cred);
  assert.equal(cred.accessToken, "sk-ant-oat01-abc");
  assert.equal(cred.refreshToken, "sk-ant-ort01-def");
  assert.equal(cred.expiresAt, NOW + 3_600_000);
  assert.equal(cred.refreshExpiresAt, NOW + 86_400_000);
  assert.deepEqual(cred.info, [["subscription", "pro · default_claude_ai"]]);
});

test("extractAnthropic: matches on shape, not the claudeAiOauth key name", () => {
  const cred = extractAnthropic({ renamedLater: { accessToken: "sk-ant-x" } });
  assert.equal(cred?.accessToken, "sk-ant-x");
  const root = extractAnthropic({ accessToken: "sk-ant-root" });
  assert.equal(root?.accessToken, "sk-ant-root");
});

test("extractAnthropic: rejects non-credential shapes", () => {
  assert.equal(extractAnthropic({ foo: "bar" }), undefined);
  assert.equal(extractAnthropic({ nested: { accessToken: 42 } }), undefined);
  assert.equal(extractAnthropic([1, 2]), undefined);
  assert.equal(extractAnthropic("string"), undefined);
});

test("extractXAI: matches on value shape, not the scope key", () => {
  const cred = extractXAI(JSON.parse(grokFile));
  assert.ok(cred);
  assert.equal(cred.accessToken, "eyJ0.grok.token");
  assert.equal(cred.refreshToken, "grok-refresh");
  assert.equal(cred.expiresAt, NOW + 7_200_000);
  assert.equal(cred.oidcIssuer, "https://auth.x.ai");
  assert.equal(cred.oidcClientId, "b1a00492-073a-47ea-816f-4c329264a828");
  assert.deepEqual(cred.info, [["account", "chee <user@example.com>"]]);

  const renamed = extractXAI({ "totally::different::scope": { key: "tok2" } });
  assert.equal(renamed?.accessToken, "tok2");
});

test("extractXAI: several entries — keeps the one expiring last", () => {
  const cred = extractXAI({
    old: { key: "stale", expires_at: new Date(NOW - 1000).toISOString() },
    new: { key: "fresh", expires_at: new Date(NOW + 1000).toISOString() },
  });
  assert.equal(cred?.accessToken, "fresh");
});

test("extractXAI: skips api_key/web_login scopes, prefers the refreshable session", () => {
  const cred = extractXAI({
    "xai::api_key": { key: "xai-APIKEY", auth_mode: "api_key" },
    "https://accounts.x.ai/sign-in": {
      key: "legacy",
      auth_mode: "web_login",
      refresh_token: "legacy-rt",
    },
    "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
      key: "session",
      auth_mode: "oidc",
      refresh_token: "rt",
      expires_at: new Date(NOW + 3_600_000).toISOString(),
      oidc_issuer: "https://auth.x.ai",
      oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
    },
  });
  assert.equal(cred?.accessToken, "session");
  assert.equal(cred?.refreshToken, "rt");
});

test("extractXAI: prefers a refreshable entry over a later-expiring bare one", () => {
  const cred = extractXAI({
    bare: { key: "bare", expires_at: new Date(NOW + 10_000_000).toISOString() },
    session: {
      key: "session",
      refresh_token: "rt",
      expires_at: new Date(NOW + 1000).toISOString(),
    },
  });
  assert.equal(cred?.accessToken, "session");
});

test("extractXAI: rejects non-credential shapes", () => {
  assert.equal(extractXAI({ scope: { email: "a@b.c" } }), undefined);
  assert.equal(extractXAI({ scope: "string" }), undefined);
});

test("detectProvider: falls back through candidate names and skips bad JSON", () => {
  const detection = detectProvider(
    xaiSpec,
    io({
      "/home/u/.grok/auth.json": "{not json",
      "/home/u/.grok/credentials.json": grokFile,
    }),
  );
  assert.equal(detection.file, "~/.grok/credentials.json");
  assert.equal(detection.cred?.accessToken, "eyJ0.grok.token");
});

test("detectProvider: shape mismatch in the first file falls through", () => {
  const detection = detectProvider(
    anthropicSpec,
    io({
      "/home/u/.claude/.credentials.json": JSON.stringify({ other: true }),
      "/home/u/.claude/auth.json": anthropicFile,
    }),
  );
  assert.equal(detection.file, "~/.claude/auth.json");
});

test("renderDetections: full output with env block", () => {
  const detections = detectAll(
    io({
      "/home/u/.claude/.credentials.json": anthropicFile,
      "/home/u/.grok/auth.json": grokFile,
    }),
  );
  const { text, found } = renderDetections(detections, NOW);
  assert.ok(found);
  assert.equal(
    text,
    [
      "Anthropic (Claude Code)",
      "  file           ~/.claude/.credentials.json",
      "  subscription   pro · default_claude_ai",
      "  access token   valid · expires 2026-07-12 13:00 UTC",
      "  refresh token  present · expires 2026-07-13 12:00 UTC",
      "",
      "xAI (Grok CLI)",
      "  file           ~/.grok/auth.json",
      "  account        chee <user@example.com>",
      "  access token   valid · expires 2026-07-12 14:00 UTC",
      "  refresh token  present",
      "",
      "# .env — cardan reads these automatically",
      "# access token expires 2026-07-12 13:00 UTC — for a durable token run `claude setup-token`",
      "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc",
      "# access token expires 2026-07-12 14:00 UTC",
      "GROK_BUILD_OAUTH_TOKEN=eyJ0.grok.token",
    ].join("\n") + "\n",
  );
});

test("renderDetections: expired token is flagged and commented in the env block", () => {
  const expired = JSON.stringify({
    scope: { key: "old-token", expires_at: new Date(NOW - 1000).toISOString() },
  });
  const detections = detectAll(io({ "/home/u/.grok/auth.json": expired }));
  const { text, found } = renderDetections(detections, NOW);
  assert.ok(found);
  assert.match(text, /access token {3}EXPIRED 2026-07-12 11:59 UTC/);
  assert.match(text, /# expired — run `grok` to refresh, then re-run detect/);
  assert.match(text, /GROK_BUILD_OAUTH_TOKEN=old-token/);
});

test("renderDetections: nothing found", () => {
  const { text, found } = renderDetections(detectAll(io({})), NOW);
  assert.equal(found, false);
  assert.match(text, /file {11}not found \(~\/.claude\/\)/);
  assert.match(text, /file {11}not found \(~\/.grok\/\)/);
  assert.match(text, /No credentials found\./);
});

test("detectCredentials: exported from the package, honors IO overrides", async () => {
  const detections = await detectCredentials({
    home: "/home/u",
    readFile: (path) =>
      path === "/home/u/.claude/.credentials.json" ? anthropicFile : undefined,
  });
  const [anthropic, xai] = detections;
  assert.equal(anthropic?.cred?.accessToken, "sk-ant-oat01-abc");
  assert.equal(anthropic?.file, "~/.claude/.credentials.json");
  assert.equal(xai?.cred, undefined);
});

test("detectCredentials: no home dir — completes with nothing found", async () => {
  const detections = await detectCredentials({ home: "", readFile: () => undefined });
  assert.equal(detections.length, PROVIDERS.length);
  assert.ok(detections.every((d) => d.cred === undefined));
});

test("detection is independent of env vars", () => {
  // A credential-shaped env var must not fabricate a detection, and its
  // absence must not suppress a real file credential.
  const withFile = detectAll(io({ "/home/u/.grok/auth.json": grokFile }));
  assert.equal(withFile[1]?.cred?.accessToken, "eyJ0.grok.token");
  const empty = detectAll(io({}));
  assert.ok(empty.every((d) => d.cred === undefined));
});

// --- multi-user ---------------------------------------------------------

function usersIO(over: Partial<UsersIO>): UsersIO {
  return {
    currentHome: "/home/alice",
    currentUser: "alice",
    readFile: () => undefined,
    readDir: () => undefined,
    userRoots: ["/home"],
    extraHomes: ["/root"],
    ...over,
  };
}

test("enumerateHomes: current first, /home/* entries, /root, deduped", () => {
  const homes = enumerateHomes(
    usersIO({ readDir: (p) => (p === "/home" ? ["alice", "bob"] : undefined) }),
  );
  assert.deepEqual(homes, [
    { home: "/home/alice", user: "alice", current: true },
    { home: "/home/bob", user: "bob", current: false },
    { home: "/root", user: "root", current: false },
  ]);
});

test("enumerateHomes: Windows case-insensitive + separator dedupe", () => {
  const homes = enumerateHomes(
    usersIO({
      currentHome: "C:\\Users\\Me",
      currentUser: "Me",
      userRoots: ["C:/Users"],
      extraHomes: [],
      caseInsensitivePaths: true,
      readDir: () => ["me", "Bob"],
    }),
  );
  // "me" collides with the current "C:\Users\Me"; only Bob is added.
  assert.deepEqual(
    homes.map((h) => h.user),
    ["Me", "Bob"],
  );
});

test("detectUsers: files per account, accounts without credentials dropped", () => {
  const files: Record<string, string> = {
    "/home/alice/.claude/.credentials.json": anthropicFile,
    "/root/.grok/auth.json": grokFile,
  };
  const users = detectUsers(
    usersIO({
      readFile: (p) => files[p],
      readDir: (p) => (p === "/home" ? ["alice", "bob"] : undefined),
    }),
  );
  // alice (current, has cred) and root (has cred) kept; bob dropped.
  assert.deepEqual(
    users.map((u) => u.user),
    ["alice", "root"],
  );
  assert.equal(users[0]?.providers[0]?.cred?.accessToken, "sk-ant-oat01-abc");
  assert.equal(users[1]?.providers[1]?.cred?.accessToken, "eyJ0.grok.token");
});

test("detectUsers: current account always kept even with nothing found", () => {
  const users = detectUsers(usersIO({}));
  assert.deepEqual(
    users.map((u) => u.user),
    ["alice"],
  );
});

test("renderUsers: numbered env vars with per-account source annotations", () => {
  const grokAlice = JSON.stringify({
    s: { key: "grok-alice", expires_at: new Date(NOW + 1000).toISOString() },
  });
  const grokRoot = JSON.stringify({
    s: { key: "grok-root", expires_at: new Date(NOW - 1000).toISOString() },
  });
  const files: Record<string, string> = {
    "/home/alice/.claude/.credentials.json": anthropicFile,
    "/home/alice/.grok/auth.json": grokAlice,
    "/root/.grok/auth.json": grokRoot,
  };
  const users = detectUsers(
    usersIO({
      readFile: (p) => files[p],
      readDir: (p) => (p === "/home" ? ["alice"] : undefined),
    }),
  );
  const { text, found } = renderUsers(users, NOW);
  assert.ok(found);
  assert.match(text, /# alice \(current user\) — \/home\/alice/);
  assert.match(text, /# root — \/root/);
  // single Anthropic token: unsuffixed
  assert.match(text, /^CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc {2}# from alice$/m);
  // two Grok tokens: numbered + annotated, root's flagged expired
  assert.match(text, /^GROK_BUILD_OAUTH_TOKEN1=grok-alice {2}# from alice$/m);
  assert.match(
    text,
    /^GROK_BUILD_OAUTH_TOKEN2=grok-root {2}# from root \(EXPIRED — run `grok`\)$/m,
  );
  assert.match(text, /# \(numbered = one per account; keep one, drop the suffix\)/);
});

test("detectAllUsers: exported, honors IO overrides without touching the real FS", async () => {
  const users = await detectAllUsers({
    currentHome: "/home/alice",
    currentUser: "alice",
    readFile: (p) =>
      p === "/home/alice/.grok/auth.json" ? grokFile : undefined,
    readDir: () => undefined,
    userRoots: [],
    extraHomes: [],
  });
  assert.deepEqual(
    users.map((u) => u.user),
    ["alice"],
  );
  assert.equal(users[0]?.providers[1]?.cred?.accessToken, "eyJ0.grok.token");
});
