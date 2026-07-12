import { test } from "node:test";
import assert from "node:assert/strict";

import {
  loadLocalOAuth,
  loadLocalOAuthPrefix,
  localOAuthPool,
  persistLocalOAuth,
  type LocalOAuthIO,
} from "../src/local-oauth.js";
import { isCardanError } from "../src/errors.js";

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

const grokScope = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";
const grokFile = JSON.stringify({
  [grokScope]: {
    key: "eyJ0.grok.token",
    auth_mode: "oidc",
    email: "user@example.com",
    first_name: "chee",
    refresh_token: "grok-refresh",
    expires_at: new Date(NOW + 7_200_000).toISOString(),
  },
});

function memoryIO(initial: Record<string, string>): LocalOAuthIO & {
  files: Record<string, string>;
} {
  const files = { ...initial };
  return {
    files,
    readFile: (path) => files[path],
    writeFile: (path, contents) => {
      files[path] = contents;
    },
  };
}

test("persistLocalOAuth: anthropic updates tokens in place", () => {
  const path = "/home/u/.claude/.credentials.json";
  const io = memoryIO({ [path]: anthropicFile });
  persistLocalOAuth(
    path,
    "anthropic",
    "sk-ant-oat01-abc",
    {
      accessToken: "sk-ant-oat01-new",
      refreshToken: "sk-ant-ort01-new",
      expiresAt: NOW + 9_000_000,
    },
    io,
  );
  const next = JSON.parse(io.files[path]!);
  assert.equal(next.claudeAiOauth.accessToken, "sk-ant-oat01-new");
  assert.equal(next.claudeAiOauth.refreshToken, "sk-ant-ort01-new");
  assert.equal(next.claudeAiOauth.expiresAt, NOW + 9_000_000);
  assert.equal(next.organizationUuid, "org-uuid");
});

test("persistLocalOAuth: xai updates key/refresh_token/expires_at", () => {
  const path = "/home/u/.grok/auth.json";
  const io = memoryIO({ [path]: grokFile });
  persistLocalOAuth(
    path,
    "xai",
    "eyJ0.grok.token",
    {
      accessToken: "eyJ0.grok.new",
      refreshToken: "grok-refresh-new",
      expiresAt: NOW + 10_000_000,
    },
    io,
  );
  const next = JSON.parse(io.files[path]!);
  assert.equal(next[grokScope].key, "eyJ0.grok.new");
  assert.equal(next[grokScope].refresh_token, "grok-refresh-new");
  assert.equal(next[grokScope].expires_at, new Date(NOW + 10_000_000).toISOString());
  assert.equal(next[grokScope].email, "user@example.com");
});

test("persistLocalOAuth: throws when entry not found", () => {
  const path = "/home/u/.grok/auth.json";
  const io = memoryIO({ [path]: grokFile });
  assert.throws(
    () =>
      persistLocalOAuth(
        path,
        "xai",
        "not-the-token",
        { accessToken: "x", refreshToken: "y", expiresAt: null },
        io,
      ),
    (err: unknown) => isCardanError(err) && err.code === "auth",
  );
});

test("loadLocalOAuth: file members are refreshable and labeled", async () => {
  const io = memoryIO({
    "/home/u/.claude/.credentials.json": anthropicFile,
    "/home/u/.grok/auth.json": grokFile,
  });
  const members = await loadLocalOAuth({
    home: "/home/u",
    io,
  });
  assert.equal(members.length, 2);

  const anth = members.find((m) => m.prefix === "anthropic");
  assert.ok(anth);
  assert.equal(anth.canRefresh, true);
  assert.equal(anth.path, "/home/u/.claude/.credentials.json");
  assert.equal(anth.label, "pro · default_claude_ai");
  assert.equal(anth.provider.name, "anthropic");

  const xai = members.find((m) => m.prefix === "xai");
  assert.ok(xai);
  assert.equal(xai.canRefresh, true);
  assert.equal(xai.label, "chee");
  assert.equal(xai.provider.name, "xai-oauth");
});

test("loadLocalOAuth: env token deduped against file (file wins)", async () => {
  const io = memoryIO({
    "/home/u/.grok/auth.json": grokFile,
  });
  const prev = process.env.GROK_BUILD_OAUTH_TOKEN;
  process.env.GROK_BUILD_OAUTH_TOKEN = "eyJ0.grok.token"; // same as file
  try {
    const members = await loadLocalOAuth({
      home: "/home/u",
      io,
      prefixes: ["xai"],
      env: ["GROK_BUILD_OAUTH_TOKEN"],
    });
    assert.equal(members.length, 1);
    assert.equal(members[0]!.canRefresh, true);
    assert.equal(members[0]!.path, "/home/u/.grok/auth.json");
  } finally {
    if (prev === undefined) delete process.env.GROK_BUILD_OAUTH_TOKEN;
    else process.env.GROK_BUILD_OAUTH_TOKEN = prev;
  }
});

test("loadLocalOAuth: distinct env tokens become extra members", async () => {
  const io = memoryIO({
    "/home/u/.grok/auth.json": grokFile,
  });
  const members = await loadLocalOAuth({
    home: "/home/u",
    io,
    prefixes: ["xai"],
    tokens: [
      { prefix: "xai", accessToken: "other-token", label: "extra" },
    ],
  });
  assert.equal(members.length, 2);
  assert.equal(members[0]!.canRefresh, true);
  assert.equal(members[1]!.label, "extra");
  assert.equal(members[1]!.canRefresh, false);
});

test("loadLocalOAuth: files:false skips credential files", async () => {
  const io = memoryIO({
    "/home/u/.grok/auth.json": grokFile,
  });
  const members = await loadLocalOAuth({
    home: "/home/u",
    io,
    files: false,
    prefixes: ["xai"],
    tokens: [{ prefix: "xai", accessToken: "env-only", label: "env" }],
  });
  assert.equal(members.length, 1);
  assert.equal(members[0]!.label, "env");
  assert.equal(members[0]!.canRefresh, false);
  assert.equal(members[0]!.path, undefined);
});

test("localOAuthPool: empty → undefined; non-empty → pool", async () => {
  const empty = await localOAuthPool("xai", {
    home: "/home/empty",
    io: memoryIO({}),
  });
  assert.equal(empty, undefined);

  const pool = await localOAuthPool("xai", {
    home: "/home/u",
    io: memoryIO({ "/home/u/.grok/auth.json": grokFile }),
  });
  assert.ok(pool);
  assert.equal(pool.name, "xai-oauth");
  assert.equal(pool.rateLimits().length, 1);
  assert.equal(pool.rateLimits()[0]!.label, "chee");
});

test("detect path is absolute", async () => {
  const { detectAll } = await import("../src/detect.js");
  const detections = detectAll({
    home: "/home/u",
    readFile: (p) =>
      p === "/home/u/.grok/auth.json" ? grokFile : undefined,
  });
  const xai = detections.find((d) => d.spec.envVar === "GROK_BUILD_OAUTH_TOKEN");
  assert.equal(xai?.file, "~/.grok/auth.json");
  assert.equal(xai?.path, "/home/u/.grok/auth.json");
});
