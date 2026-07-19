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
    env: false, // isolate from host env
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
    env: false,
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
    env: false,
    tokens: [{ prefix: "xai", accessToken: "env-only", label: "env" }],
  });
  assert.equal(members.length, 1);
  assert.equal(members[0]!.label, "env");
  assert.equal(members[0]!.canRefresh, false);
  assert.equal(members[0]!.path, undefined);
});

test("loadLocalOAuth: env family expands BASE / BASE1 / BASE2 / BASE10", async () => {
  const keys = [
    "GROK_BUILD_OAUTH_TOKEN",
    "GROK_BUILD_OAUTH_TOKEN1",
    "GROK_BUILD_OAUTH_TOKEN2",
    "GROK_BUILD_OAUTH_TOKEN10",
    "GROK_BUILD_OAUTH_TOKEN_OTHER", // must not match
  ] as const;
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GROK_BUILD_OAUTH_TOKEN2 = "tok-2";
  process.env.GROK_BUILD_OAUTH_TOKEN10 = "tok-10";
  process.env.GROK_BUILD_OAUTH_TOKEN1 = "tok-1";
  process.env.GROK_BUILD_OAUTH_TOKEN = "tok-bare";
  process.env.GROK_BUILD_OAUTH_TOKEN_OTHER = "tok-other";
  try {
    const members = await loadLocalOAuth({
      home: "/home/empty",
      io: memoryIO({}),
      files: false,
      prefixes: ["xai"],
      // default env:true → GROK_BUILD_OAUTH_TOKEN family
    });
    assert.deepEqual(
      members.map((m) => m.label),
      [
        "GROK_BUILD_OAUTH_TOKEN",
        "GROK_BUILD_OAUTH_TOKEN1",
        "GROK_BUILD_OAUTH_TOKEN2",
        "GROK_BUILD_OAUTH_TOKEN10",
      ],
    );
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("expandEnvFamily: bare first, then numeric order; ignores non-suffix", async () => {
  const { expandEnvFamily } = await import("../src/env.js");
  const base = "CARDAN_TEST_ENV_FAM";
  const keys = [`${base}`, `${base}1`, `${base}2`, `${base}10`, `${base}_X`, `${base}BAR`];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env[`${base}10`] = "c";
  process.env[`${base}2`] = "d";
  process.env[`${base}`] = "a";
  process.env[`${base}1`] = "b";
  process.env[`${base}_X`] = "no";
  process.env[`${base}BAR`] = "no";
  try {
    assert.deepEqual(expandEnvFamily(base), [
      base,
      `${base}1`,
      `${base}2`,
      `${base}10`,
    ]);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("localOAuthPool: empty → undefined; non-empty → pool", async () => {
  const empty = await localOAuthPool("xai", {
    home: "/home/empty",
    io: memoryIO({}),
    env: false,
  });
  assert.equal(empty, undefined);

  const pool = await localOAuthPool("xai", {
    home: "/home/u",
    io: memoryIO({ "/home/u/.grok/auth.json": grokFile }),
    env: false,
  });
  assert.ok(pool);
  assert.equal(pool.name, "xai-oauth");
  assert.equal(pool.rateLimits().length, 1);
  assert.equal(pool.rateLimits()[0]!.label, "chee");
});

test("file member: adopts external rotation via reload; write-back still matches after", async () => {
  const path = "/home/u/.grok/auth.json";
  const io = memoryIO({
    [path]: JSON.stringify({
      [grokScope]: {
        key: "old-token",
        refresh_token: "old-refresh",
        expires_at: new Date(Date.now() - 1000).toISOString(), // expired in memory
      },
    }),
  });
  const calls: Array<{ url: string; auth: string; body: string }> = [];
  let rejectOnce = false;
  const fetchStub: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization") ?? "";
    calls.push({ url, auth, body: String(init?.body ?? "") });
    if (url.includes("/.well-known/openid-configuration")) {
      return new Response(JSON.stringify({ token_endpoint: "https://auth.x.ai/oauth2/token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/oauth2/token")) {
      return new Response(
        JSON.stringify({ access_token: "net-new", refresh_token: "net-refresh", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (rejectOnce) {
      rejectOnce = false;
      return new Response(JSON.stringify({ error: { message: "expired" } }), { status: 401 });
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchStub; // members are built on globalThis.fetch
  try {
    const members = await loadLocalOAuthPrefix("xai", { home: "/home/u", io, env: false });
    assert.equal(members.length, 1);
    const provider = members[0]!.provider;

    // The CLI rotates the file after load: memory still holds old-token.
    io.files[path] = JSON.stringify({
      [grokScope]: {
        key: "cli-new",
        refresh_token: "cli-refresh",
        expires_at: new Date(Date.now() + 7_200_000).toISOString(),
      },
    });

    // Proactive refresh reloads the file and adopts — no token endpoint call.
    const { textMessage } = await import("../src/index.js");
    await provider.generate({ model: "grok-4.5", messages: [textMessage("user", "a")] });
    assert.equal(calls.filter((c) => c.url.includes("/oauth2/token")).length, 0);
    assert.equal(calls.at(-1)!.auth, "Bearer cli-new", "served with the CLI-rotated token");

    // Next 401 goes to the network (file unchanged) using the reloaded refresh
    // token; write-back must match the file entry (held synced by reload).
    rejectOnce = true;
    await provider.generate({ model: "grok-4.5", messages: [textMessage("user", "b")] });
    const tokenCalls = calls.filter((c) => c.url.includes("/oauth2/token"));
    assert.equal(tokenCalls.length, 1);
    assert.equal(new URLSearchParams(tokenCalls[0]!.body).get("refresh_token"), "cli-refresh");
    assert.equal(calls.at(-1)!.auth, "Bearer net-new");
    const persisted = JSON.parse(io.files[path]!);
    assert.equal(persisted[grokScope].key, "net-new", "write-back matched the rotated entry");
    assert.equal(persisted[grokScope].refresh_token, "net-refresh");
  } finally {
    globalThis.fetch = origFetch;
  }
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
