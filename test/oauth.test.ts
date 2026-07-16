import { test } from "node:test";
import assert from "node:assert/strict";

import { AnthropicProvider } from "../src/providers/anthropic.js";
import type { OAuthCredentials } from "../src/index.js";
import { CardanError, textMessage } from "../src/index.js";

const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

const MESSAGE_FIXTURE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "hi" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Routes the OAuth token endpoint vs the messages endpoint by URL. */
function routedFetch(opts: {
  calls: Call[];
  onToken: () => Response;
  onMessages: (call: Call) => Response;
}): typeof globalThis.fetch {
  return async (input, init) => {
    const url = String(input);
    const call: Call = {
      url,
      headers: { ...(init?.headers as Record<string, string>) },
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    opts.calls.push(call);
    if (url.includes("oauth/token")) return opts.onToken();
    return opts.onMessages(call);
  };
}

function tokenResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function messageResponse(status = 200, body: unknown = MESSAGE_FIXTURE): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("oauth mode: bearer auth, oauth beta, identity system block, no api key", async () => {
  const calls: Call[] = [];
  const provider = new AnthropicProvider({
    oauth: {
      credentials: { accessToken: "AT", refreshToken: "RT", expiresAt: Date.now() + 3_600_000 },
    },
    headers: { "anthropic-beta": "custom-flag" },
    fetch: routedFetch({ calls, onToken: () => tokenResponse({}), onMessages: () => messageResponse() }),
  });

  await provider.generate({
    model: "claude-opus-4-8",
    messages: [textMessage("system", "be terse"), textMessage("user", "hi")],
  });

  assert.equal(calls.length, 1);
  const { headers, body } = calls[0]!;
  assert.equal(headers["authorization"], "Bearer AT");
  assert.equal(headers["x-api-key"], undefined, "must not send x-api-key in oauth mode");
  const beta = headers["anthropic-beta"] ?? "";
  assert.ok(beta.includes("oauth-2025-04-20"), "oauth beta present");
  assert.ok(beta.includes("custom-flag"), "user beta preserved");
  const system = body.system as Array<{ type: string; text: string }>;
  assert.equal(system[0]!.text, IDENTITY, "identity is the first system block");
  assert.equal(system[1]!.text, "be terse", "user system follows identity");
});

test("oauth mode: a bare token string is shorthand for credentials.accessToken", async () => {
  const calls: Call[] = [];
  const provider = new AnthropicProvider({
    oauth: "AT", // shorthand for { credentials: { accessToken: "AT" } }
    fetch: routedFetch({ calls, onToken: () => tokenResponse({}), onMessages: () => messageResponse() }),
  });
  await provider.generate({ model: "claude-opus-4-8", messages: [textMessage("user", "hi")] });
  assert.equal(calls[0]!.headers["authorization"], "Bearer AT");
  assert.equal(calls[0]!.headers["x-api-key"], undefined);
});

test("oauth mode: a 429 surfaces the unified reset as resetAt", async () => {
  const resetEpoch = Math.floor(Date.now() / 1000) + 3600;
  let calls = 0;
  const fetch429: typeof globalThis.fetch = async (input) => {
    if (String(input).includes("oauth/token")) return tokenResponse({});
    calls++;
    return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 429,
      headers: {
        "content-type": "application/json",
        "anthropic-ratelimit-unified-reset": String(resetEpoch),
        // Multi-hour Retry-After must NOT cause a hang: subscription 429s are
        // non-retryable so the default withRetry path throws immediately.
        "retry-after": String(3600),
      },
    });
  };
  const provider = new AnthropicProvider({ oauth: "AT", fetch: fetch429 });
  await assert.rejects(
    provider.generate({ model: "claude-opus-4-8", messages: [textMessage("user", "hi")] }),
    (err: unknown) => {
      assert.ok(err instanceof CardanError);
      assert.equal(err.code, "rate_limit");
      assert.equal(err.resetAt, resetEpoch * 1000);
      assert.equal(err.retryable, false);
      return true;
    },
  );
  // Only one attempt — did not sit on the 1h Retry-After.
  assert.equal(calls, 1);
  // Ops reads provider.rateLimit after the failure; snapshot must reflect
  // the exhausted subscription window, not stay undefined / stale-success.
  assert.equal(provider.rateLimit?.status, "exhausted");
  assert.equal(provider.rateLimit?.resetAt, resetEpoch * 1000);
});

test("oauth mode: a 429 with full unified headers overwrites lastRateLimit", async () => {
  const resetEpoch = Math.floor(Date.now() / 1000) + 7200;
  const headers = {
    "content-type": "application/json",
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
    "anthropic-ratelimit-unified-reset": String(resetEpoch),
    "anthropic-ratelimit-unified-5h-utilization": "1",
    "anthropic-ratelimit-unified-5h-status": "rejected",
    "anthropic-ratelimit-unified-5h-reset": String(resetEpoch),
  };
  const fetch429: typeof globalThis.fetch = async (input) => {
    if (String(input).includes("oauth/token")) return tokenResponse({});
    return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 429,
      headers,
    });
  };
  const provider = new AnthropicProvider({ oauth: "AT", fetch: fetch429 });
  await assert.rejects(
    provider.generate({ model: "claude-opus-4-8", messages: [textMessage("user", "hi")] }),
  );
  assert.equal(provider.rateLimit?.status, "rejected");
  assert.equal(provider.rateLimit?.representative, "five_hour");
  assert.equal(provider.rateLimit?.fiveHour?.status, "rejected");
  assert.equal(provider.rateLimit?.resetAt, resetEpoch * 1000);
});

test("oauth mode: no api key required (does not throw)", async () => {
  const calls: Call[] = [];
  const provider = new AnthropicProvider({
    oauth: { credentials: { accessToken: "AT" } }, // no apiKey, no env
    fetch: routedFetch({ calls, onToken: () => tokenResponse({}), onMessages: () => messageResponse() }),
  });
  await assert.doesNotReject(() =>
    provider.generate({ model: "claude-opus-4-8", messages: [textMessage("user", "hi")] }),
  );
});

test("oauth mode: proactive refresh on expiry, rotation persisted, deduped", async () => {
  const calls: Call[] = [];
  const refreshed: OAuthCredentials[] = [];
  const provider = new AnthropicProvider({
    oauth: {
      credentials: { accessToken: "AT", refreshToken: "RT", expiresAt: Date.now() - 1 }, // expired
      onRefresh: (c) => {
        refreshed.push(c);
      },
    },
    fetch: routedFetch({
      calls,
      onToken: () =>
        tokenResponse({ access_token: "AT2", refresh_token: "RT2", expires_in: 3600, scope: "user:inference" }),
      onMessages: () => messageResponse(),
    }),
  });

  // Two concurrent calls -> exactly one refresh round-trip.
  await Promise.all([
    provider.generate({ model: "m", messages: [textMessage("user", "a")] }),
    provider.generate({ model: "m", messages: [textMessage("user", "b")] }),
  ]);

  const tokenCalls = calls.filter((c) => c.url.includes("oauth/token"));
  const msgCalls = calls.filter((c) => !c.url.includes("oauth/token"));
  assert.equal(tokenCalls.length, 1, "refresh deduped to one call");
  assert.equal(refreshed.length, 1, "onRefresh fired once");
  assert.equal(refreshed[0]!.refreshToken, "RT2", "rotated refresh token persisted");
  assert.equal(msgCalls.length, 2);
  assert.ok(
    msgCalls.every((c) => c.headers["authorization"] === "Bearer AT2"),
    "both messages used the refreshed token",
  );
});

test("env CLAUDE_CODE_OAUTH_TOKEN selects bearer auth, no config needed", async () => {
  const prev = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "ENV_AT";
  try {
    const calls: Call[] = [];
    const provider = new AnthropicProvider({
      fetch: routedFetch({ calls, onToken: () => tokenResponse({}), onMessages: () => messageResponse() }),
    });
    await provider.generate({ model: "claude-opus-4-8", messages: [textMessage("user", "hi")] });
    assert.equal(calls[0]!.headers["authorization"], "Bearer ENV_AT");
    assert.equal(calls[0]!.headers["x-api-key"], undefined);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = prev;
  }
});

test("explicit apiKey opts out of env CLAUDE_CODE_OAUTH_TOKEN", async () => {
  const prev = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "ENV_AT";
  try {
    const calls: Call[] = [];
    const provider = new AnthropicProvider({
      apiKey: "sk-explicit",
      fetch: routedFetch({ calls, onToken: () => tokenResponse({}), onMessages: () => messageResponse() }),
    });
    await provider.generate({ model: "claude-opus-4-8", messages: [textMessage("user", "hi")] });
    assert.equal(calls[0]!.headers["x-api-key"], "sk-explicit");
    assert.equal(calls[0]!.headers["authorization"], undefined);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = prev;
  }
});

test("oauth mode: 401 triggers refresh + single retry, then recovers", async () => {
  const calls: Call[] = [];
  const provider = new AnthropicProvider({
    oauth: {
      // Looks valid locally so there is no proactive refresh; the server rejects it.
      credentials: { accessToken: "STALE", refreshToken: "RT", expiresAt: Date.now() + 3_600_000 },
    },
    retry: false,
    fetch: routedFetch({
      calls,
      onToken: () => tokenResponse({ access_token: "GOOD", expires_in: 3600 }),
      onMessages: (call) =>
        call.headers["authorization"] === "Bearer GOOD"
          ? messageResponse(200, { ...MESSAGE_FIXTURE, id: "recovered" })
          : messageResponse(401, { error: { message: "oauth token expired" } }),
    }),
  });

  const res = await provider.generate({ model: "m", messages: [textMessage("user", "hi")] });
  const tokenCalls = calls.filter((c) => c.url.includes("oauth/token"));
  const msgCalls = calls.filter((c) => !c.url.includes("oauth/token"));
  assert.equal(tokenCalls.length, 1, "one refresh");
  assert.equal(msgCalls.length, 2, "one failed + one retried");
  assert.equal((res.raw as { id: string }).id, "recovered");
});

test("oauth mode: a 403 also triggers refresh + retry", async () => {
  const calls: Call[] = [];
  const provider = new AnthropicProvider({
    oauth: { credentials: { accessToken: "STALE", refreshToken: "RT", expiresAt: Date.now() + 3_600_000 } },
    retry: false,
    fetch: routedFetch({
      calls,
      onToken: () => tokenResponse({ access_token: "GOOD", expires_in: 3600 }),
      onMessages: (call) =>
        call.headers["authorization"] === "Bearer GOOD"
          ? messageResponse(200, { ...MESSAGE_FIXTURE, id: "recovered" })
          : messageResponse(403, { error: { message: "forbidden" } }),
    }),
  });
  const res = await provider.generate({ model: "m", messages: [textMessage("user", "hi")] });
  assert.equal(calls.filter((c) => c.url.includes("oauth/token")).length, 1, "403 refreshed once");
  assert.equal((res.raw as { id: string }).id, "recovered");
});

test("oauth mode: overlapping 401s collapse into a single refresh", async () => {
  const calls: Call[] = [];
  const provider = new AnthropicProvider({
    oauth: { credentials: { accessToken: "STALE", refreshToken: "RT", expiresAt: Date.now() + 3_600_000 } },
    retry: false,
    fetch: routedFetch({
      calls,
      onToken: () => tokenResponse({ access_token: "GOOD", expires_in: 3600 }),
      onMessages: (call) =>
        call.headers["authorization"] === "Bearer GOOD"
          ? messageResponse()
          : messageResponse(401, { error: { message: "stale" } }),
    }),
  });
  // Both requests send STALE and get 401; refreshIfUnchanged means whichever
  // reaches its 401 handler second either shares the in-flight refresh or, if
  // the first already rotated, skips refreshing — exactly one token round-trip.
  await Promise.all([
    provider.generate({ model: "m", messages: [textMessage("user", "a")] }),
    provider.generate({ model: "m", messages: [textMessage("user", "b")] }),
  ]);
  assert.equal(
    calls.filter((c) => c.url.includes("oauth/token")).length,
    1,
    "two overlapping 401s triggered only one refresh",
  );
});

test("oauth mode: reload adopting rotated credentials skips the token endpoint and onRefresh", async () => {
  const calls: Call[] = [];
  let refreshes = 0;
  const provider = new AnthropicProvider({
    oauth: {
      credentials: { accessToken: "AT", refreshToken: "RT", expiresAt: Date.now() - 1 }, // expired
      reload: () => ({
        accessToken: "AT2",
        refreshToken: "RT2",
        expiresAt: Date.now() + 3_600_000,
      }),
      onRefresh: () => {
        refreshes++;
      },
    },
    fetch: routedFetch({ calls, onToken: () => tokenResponse({}), onMessages: () => messageResponse() }),
  });
  await provider.generate({ model: "m", messages: [textMessage("user", "hi")] });
  assert.equal(calls.filter((c) => c.url.includes("oauth/token")).length, 0, "no network refresh");
  assert.equal(refreshes, 0, "reloaded credentials are not re-persisted");
  assert.equal(calls[0]!.headers["authorization"], "Bearer AT2");
});

test("oauth mode: reload returning unchanged credentials still refreshes over the network", async () => {
  const calls: Call[] = [];
  const expiresAt = Date.now() - 1;
  const provider = new AnthropicProvider({
    oauth: {
      credentials: { accessToken: "AT", refreshToken: "RT", expiresAt },
      reload: () => ({ accessToken: "AT", refreshToken: "RT", expiresAt }),
    },
    fetch: routedFetch({
      calls,
      onToken: () => tokenResponse({ access_token: "AT2", refresh_token: "RT2", expires_in: 3600 }),
      onMessages: () => messageResponse(),
    }),
  });
  await provider.generate({ model: "m", messages: [textMessage("user", "hi")] });
  assert.equal(calls.filter((c) => c.url.includes("oauth/token")).length, 1);
  const msgCalls = calls.filter((c) => !c.url.includes("oauth/token"));
  assert.equal(msgCalls[0]!.headers["authorization"], "Bearer AT2");
});

test("oauth mode: a throwing reload warns and falls back to the network refresh", async () => {
  const calls: Call[] = [];
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  try {
    const provider = new AnthropicProvider({
      oauth: {
        credentials: { accessToken: "AT", refreshToken: "RT", expiresAt: Date.now() - 1 },
        reload: () => {
          throw new Error("fs gone");
        },
      },
      fetch: routedFetch({
        calls,
        onToken: () => tokenResponse({ access_token: "AT2", expires_in: 3600 }),
        onMessages: () => messageResponse(),
      }),
    });
    await provider.generate({ model: "m", messages: [textMessage("user", "hi")] });
    assert.equal(calls.filter((c) => c.url.includes("oauth/token")).length, 1);
    assert.ok(
      warnings.some((w) => /credential reload failed/.test(w)),
      "reload failure was surfaced as a warning",
    );
  } finally {
    console.warn = origWarn;
  }
});

test("oauth mode: a failing onRefresh warns but does not fail the request", async () => {
  const calls: Call[] = [];
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
  try {
    const provider = new AnthropicProvider({
      oauth: {
        // Expired -> proactive refresh; persistence then throws.
        credentials: { accessToken: "AT", refreshToken: "RT", expiresAt: Date.now() - 1 },
        onRefresh: () => {
          throw new Error("disk full");
        },
      },
      fetch: routedFetch({
        calls,
        onToken: () => tokenResponse({ access_token: "AT2", refresh_token: "RT2", expires_in: 3600 }),
        onMessages: () => messageResponse(),
      }),
    });
    // Must resolve despite the persistence failure.
    await provider.generate({ model: "m", messages: [textMessage("user", "hi")] });
    const msgCalls = calls.filter((c) => !c.url.includes("oauth/token"));
    assert.equal(msgCalls.length, 1);
    assert.equal(msgCalls[0]!.headers["authorization"], "Bearer AT2", "served with the fresh token");
    assert.ok(
      warnings.some((w) => /failed to persist refreshed credentials/.test(w)),
      "persistence failure was surfaced as a warning",
    );
  } finally {
    console.warn = origWarn;
  }
});
