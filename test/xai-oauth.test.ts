import { test } from "node:test";
import assert from "node:assert/strict";

import { XAIOAuthProvider } from "../src/providers/xai-oauth.js";
import { createCardan, textMessage } from "../src/index.js";

const CHAT_FIXTURE = {
  choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function chatResponse(status = 200, body: unknown = CHAT_FIXTURE): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function tokenResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Records every request; routes the token endpoint vs the chat endpoint by URL. */
function routedFetch(opts: {
  calls: Call[];
  onToken?: () => Response;
  onChat: (call: Call) => Response;
}): typeof globalThis.fetch {
  return async (input, init) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call: Call = { url, headers, body: String(init?.body ?? "") };
    opts.calls.push(call);
    if (url.includes("/oauth2/token")) return (opts.onToken ?? (() => tokenResponse({})))();
    return opts.onChat(call);
  };
}

test("subscription mode: proxy url, bearer, cli token header, model-override header", async () => {
  const calls: Call[] = [];
  const provider = new XAIOAuthProvider({
    credentials: { accessToken: "AT", refreshToken: "RT", expiresAt: Date.now() + 3_600_000 },
    fetch: routedFetch({ calls, onChat: () => chatResponse() }),
  });

  const result = await provider.generate({
    model: "grok-4.5",
    messages: [textMessage("user", "hi")],
  });

  assert.equal(result.text, "hi");
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, "https://cli-chat-proxy.grok.com/v1/chat/completions");
  assert.equal(call.headers["authorization"], "Bearer AT");
  assert.equal(call.headers["x-xai-token-auth"], "xai-grok-cli");
  assert.equal(call.headers["x-grok-model-override"], "grok-4.5");
  // Proxy 426s without a current client version.
  assert.match(call.headers["x-grok-client-version"] ?? "", /^\d+\.\d+\.\d+$/);
  assert.equal(call.headers["x-grok-client-surface"], "grok-shell");
  // No stray api key path — the proxy never sees the "oauth" placeholder.
  assert.notEqual(call.headers["authorization"], "Bearer oauth");
});

test("401 triggers one refresh (form-encoded) then replays with the new token", async () => {
  const calls: Call[] = [];
  let rotated: Required<{ accessToken: string; refreshToken: string | null; expiresAt: number | null }> | undefined;
  let firstChat = true;
  const provider = new XAIOAuthProvider({
    credentials: { accessToken: "OLD", refreshToken: "RT" }, // no expiresAt -> refresh only on 401
    onRefresh: (c) => {
      rotated = c;
    },
    fetch: routedFetch({
      calls,
      onToken: () => tokenResponse({ access_token: "NEW", refresh_token: "RT2", expires_in: 3600 }),
      onChat: () => {
        if (firstChat) {
          firstChat = false;
          return chatResponse(401, { error: { message: "expired" } });
        }
        return chatResponse();
      },
    }),
  });

  const result = await provider.generate({
    model: "grok-4.5",
    messages: [textMessage("user", "hi")],
  });
  assert.equal(result.text, "hi");

  // chat(401) -> token refresh -> chat(200)
  assert.equal(calls.length, 3);
  const tokenCall = calls[1]!;
  assert.ok(tokenCall.url.endsWith("/oauth2/token"));
  const form = new URLSearchParams(tokenCall.body);
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "RT");
  assert.equal(form.get("client_id"), "grok-cli");
  // replay used the rotated token
  assert.equal(calls[2]!.headers["authorization"], "Bearer NEW");
  assert.equal(rotated?.accessToken, "NEW");
  assert.equal(rotated?.refreshToken, "RT2");
});

test("proactive refresh when the access token is near expiry", async () => {
  const calls: Call[] = [];
  const provider = new XAIOAuthProvider({
    credentials: { accessToken: "OLD", refreshToken: "RT", expiresAt: Date.now() + 1000 }, // within buffer
    fetch: routedFetch({
      calls,
      onToken: () => tokenResponse({ access_token: "NEW", expires_in: 3600 }),
      onChat: () => chatResponse(),
    }),
  });

  await provider.generate({ model: "grok-4.5", messages: [textMessage("user", "hi")] });

  // token refresh happens before the chat call
  assert.ok(calls[0]!.url.endsWith("/oauth2/token"));
  assert.equal(calls[1]!.headers["authorization"], "Bearer NEW");
});

test("string-form proxy error reaches the app layer (426 version outdated)", async () => {
  const provider = new XAIOAuthProvider({
    credentials: { accessToken: "AT" },
    fetch: routedFetch({
      calls: [],
      onChat: () =>
        new Response(JSON.stringify({ error: "Your Grok CLI version (none) is outdated." }), {
          status: 426,
          headers: { "content-type": "application/json" },
        }),
    }),
  });
  await assert.rejects(
    provider.generate({ model: "grok-4.5", messages: [textMessage("user", "hi")] }),
    (err: Error) =>
      /Grok CLI version .* is outdated/.test(err.message) && /clientVersion/.test(err.message),
  );
});

test("xai auth precedence: env token vs api key vs config", () => {
  const saved = { oauth: process.env.GROK_BUILD_OAUTH_TOKEN, key: process.env.XAI_API_KEY };
  try {
    // env OAuth token -> subscription provider
    delete process.env.XAI_API_KEY;
    process.env.GROK_BUILD_OAUTH_TOKEN = "AT";
    assert.equal(createCardan().provider("xai").name, "xai-oauth");

    // both set -> OAuth wins (subscription)
    process.env.XAI_API_KEY = "xai-key";
    assert.equal(createCardan().provider("xai").name, "xai-oauth");

    // only api key -> pay-per-token provider
    delete process.env.GROK_BUILD_OAUTH_TOKEN;
    assert.equal(createCardan().provider("xai").name, "xai");

    // explicit config apiKey opts out of subscription even with env token set
    process.env.GROK_BUILD_OAUTH_TOKEN = "AT";
    assert.equal(createCardan({ xai: { apiKey: "k" } }).provider("xai").name, "xai");

    // explicit xaiOAuth config wins over everything
    assert.equal(
      createCardan({ xaiOAuth: { credentials: { accessToken: "AT" } } }).provider("xai").name,
      "xai-oauth",
    );
  } finally {
    if (saved.oauth === undefined) delete process.env.GROK_BUILD_OAUTH_TOKEN;
    else process.env.GROK_BUILD_OAUTH_TOKEN = saved.oauth;
    if (saved.key === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = saved.key;
  }
});

test("no refresh token: a 401 surfaces as an auth error", async () => {
  const provider = new XAIOAuthProvider({
    credentials: { accessToken: "AT" }, // no refresh token
    fetch: routedFetch({ calls: [], onChat: () => chatResponse(401, { error: { message: "nope" } }) }),
  });
  await assert.rejects(
    provider.generate({ model: "grok-4.5", messages: [textMessage("user", "hi")] }),
    /nope|auth|401/i,
  );
});
