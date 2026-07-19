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

/** OIDC discovery doc; the refresh flow reads `token_endpoint` from here. */
function discoveryResponse(
  tokenEndpoint = "https://auth.x.ai/oauth2/token",
): Response {
  return new Response(JSON.stringify({ token_endpoint: tokenEndpoint }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Records every request; routes discovery, the token endpoint, and the chat
 * endpoint by URL. A refresh is therefore two calls: the discovery GET, then
 * the token POST.
 */
function routedFetch(opts: {
  calls: Call[];
  onDiscovery?: () => Response;
  onToken?: () => Response;
  onChat: (call: Call) => Response;
}): typeof globalThis.fetch {
  return async (input, init) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call: Call = { url, headers, body: String(init?.body ?? "") };
    opts.calls.push(call);
    if (url.includes("/.well-known/openid-configuration")) {
      return (opts.onDiscovery ?? (() => discoveryResponse()))();
    }
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

  // chat(401) -> discovery GET -> token POST -> chat(200)
  assert.equal(calls.length, 4);
  const tokenCall = calls.find((c) => c.url.includes("/oauth2/token"))!;
  // The refresh hits the discovered auth.x.ai endpoint, NOT accounts.x.ai.
  assert.equal(tokenCall.url, "https://auth.x.ai/oauth2/token");
  const form = new URLSearchParams(tokenCall.body);
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "RT");
  // The real public client id, not the reverse-engineered `grok-cli` guess.
  assert.equal(form.get("client_id"), "b1a00492-073a-47ea-816f-4c329264a828");
  // replay used the rotated token
  assert.equal(calls.at(-1)!.headers["authorization"], "Bearer NEW");
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

  // discovery GET -> token POST (refresh) both precede the chat call
  assert.ok(calls[0]!.url.endsWith("/.well-known/openid-configuration"));
  assert.equal(calls[1]!.url, "https://auth.x.ai/oauth2/token");
  assert.equal(calls.at(-1)!.headers["authorization"], "Bearer NEW");
});

test("non-JSON token endpoint response fails as a retryable server error", async () => {
  const { isCardanError } = await import("../src/errors.js");
  const calls: Call[] = [];
  const provider = new XAIOAuthProvider({
    credentials: { accessToken: "OLD", refreshToken: "RT", expiresAt: Date.now() - 1 },
    retry: false,
    fetch: routedFetch({
      calls,
      // Token endpoint serves an HTML challenge/error page with a 200 status.
      onToken: () => new Response("<html>challenge</html>", { status: 200 }),
      onChat: () => chatResponse(),
    }),
  });
  await assert.rejects(
    provider.generate({ model: "grok-4.5", messages: [textMessage("user", "hi")] }),
    (err: unknown) => {
      assert.ok(isCardanError(err));
      assert.equal(err.code, "server");
      assert.match(err.message, /non-JSON/);
      assert.ok(!err.message.includes("challenge"), "body content stays out of the error");
      return true;
    },
  );
});

test("refresh: tokenUrl override skips OIDC discovery", async () => {
  const calls: Call[] = [];
  const provider = new XAIOAuthProvider({
    credentials: { accessToken: "OLD", refreshToken: "RT", expiresAt: Date.now() - 1 },
    tokenUrl: "https://idp.example/oauth2/token",
    fetch: routedFetch({
      calls,
      onToken: () => tokenResponse({ access_token: "NEW", expires_in: 3600 }),
      onChat: () => chatResponse(),
    }),
  });
  await provider.generate({ model: "grok-4.5", messages: [textMessage("user", "hi")] });
  assert.equal(calls.filter((c) => c.url.includes("/.well-known/")).length, 0, "no discovery");
  assert.equal(calls[0]!.url, "https://idp.example/oauth2/token");
  assert.equal(calls.at(-1)!.headers["authorization"], "Bearer NEW");
});

test("refresh: custom issuer, discovery doc without token_endpoint derives {issuer}/oauth2/token", async () => {
  const calls: Call[] = [];
  const provider = new XAIOAuthProvider({
    credentials: { accessToken: "OLD", refreshToken: "RT", expiresAt: Date.now() - 1 },
    issuer: "https://idp.example/",
    clientId: "client-xyz",
    fetch: routedFetch({
      calls,
      onDiscovery: () => tokenResponse({}), // doc without token_endpoint
      onToken: () => tokenResponse({ access_token: "NEW", expires_in: 3600 }),
      onChat: () => chatResponse(),
    }),
  });
  await provider.generate({ model: "grok-4.5", messages: [textMessage("user", "hi")] });
  assert.equal(calls[0]!.url, "https://idp.example/.well-known/openid-configuration");
  const tokenCall = calls.find((c) => c.url.includes("/oauth2/token"))!;
  assert.equal(tokenCall.url, "https://idp.example/oauth2/token");
  assert.equal(new URLSearchParams(tokenCall.body).get("client_id"), "client-xyz");
});

test("refresh: discovery failure falls back to {issuer}/oauth2/token", async () => {
  const calls: Call[] = [];
  const provider = new XAIOAuthProvider({
    credentials: { accessToken: "OLD", refreshToken: "RT", expiresAt: Date.now() - 1 },
    fetch: routedFetch({
      calls,
      onDiscovery: () => {
        throw new Error("discovery unreachable");
      },
      onToken: () => tokenResponse({ access_token: "NEW", expires_in: 3600 }),
      onChat: () => chatResponse(),
    }),
  });
  await provider.generate({ model: "grok-4.5", messages: [textMessage("user", "hi")] });
  // Discovery threw; refresh still lands on the derived default-issuer endpoint.
  const tokenCall = calls.find((c) => c.url.includes("/oauth2/token"))!;
  assert.equal(tokenCall.url, "https://auth.x.ai/oauth2/token");
  assert.equal(calls.at(-1)!.headers["authorization"], "Bearer NEW");
});

test("refresh: OAuth2 error code (invalid_grant) surfaces in the auth error", async () => {
  const { isCardanError } = await import("../src/errors.js");
  const provider = new XAIOAuthProvider({
    credentials: { accessToken: "OLD", refreshToken: "RT", expiresAt: Date.now() - 1 },
    retry: false,
    fetch: routedFetch({
      calls: [],
      onToken: () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      onChat: () => chatResponse(),
    }),
  });
  await assert.rejects(
    provider.generate({ model: "grok-4.5", messages: [textMessage("user", "hi")] }),
    (err: unknown) => {
      assert.ok(isCardanError(err));
      assert.equal(err.code, "auth");
      assert.match(err.message, /invalid_grant/);
      assert.match(err.message, /grok login/);
      return true;
    },
  );
});

test("refresh: team principal_type/principal_id are forwarded", async () => {
  const calls: Call[] = [];
  const provider = new XAIOAuthProvider({
    credentials: { accessToken: "OLD", refreshToken: "RT", expiresAt: Date.now() - 1 },
    principalType: "Team",
    principalId: "team-123",
    fetch: routedFetch({
      calls,
      onToken: () => tokenResponse({ access_token: "NEW", expires_in: 3600 }),
      onChat: () => chatResponse(),
    }),
  });
  await provider.generate({ model: "grok-4.5", messages: [textMessage("user", "hi")] });
  const form = new URLSearchParams(
    calls.find((c) => c.url.includes("/oauth2/token"))!.body,
  );
  assert.equal(form.get("principal_type"), "Team");
  assert.equal(form.get("principal_id"), "team-123");
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

test("streaming requests include stream_options.include_usage (proxy sends no usage otherwise)", async () => {
  const chunks = [
    '{"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}',
    '{"choices":[],"usage":{"prompt_tokens":189,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":128}}}',
    "[DONE]",
  ];
  const sse = chunks.map((chunk) => `data: ${chunk}\n\n`).join("");
  const calls: Call[] = [];
  const provider = new XAIOAuthProvider({
    credentials: { accessToken: "AT" },
    fetch: routedFetch({ calls, onChat: () => new Response(sse, { status: 200 }) }),
  });

  let usage: unknown;
  for await (const event of provider.stream({
    model: "grok-4.5",
    messages: [textMessage("user", "hi")],
  })) {
    if (event.type === "finish") usage = event.usage;
  }

  const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.deepEqual(usage, {
    input: { total: 189, details: { cache_read: 128 } },
    output: { total: 1, details: {} },
  });
});

test("reasoning_content maps to thinking (proxy streams it by default on grok models)", async () => {
  // Wire shape verified live against cli-chat-proxy.grok.com (grok-4.5).
  const chunks = [
    '{"choices":[{"index":0,"delta":{"reasoning_content":"The problem","role":"assistant"}}]}',
    '{"choices":[{"index":0,"delta":{"reasoning_content":" asks 2+2."}}]}',
    '{"choices":[{"index":0,"delta":{"content":"4"},"finish_reason":"stop"}]}',
    "[DONE]",
  ];
  const sse = chunks.map((chunk) => `data: ${chunk}\n\n`).join("");
  const provider = new XAIOAuthProvider({
    credentials: { accessToken: "AT" },
    fetch: routedFetch({ calls: [], onChat: () => new Response(sse, { status: 200 }) }),
  });

  let thinking = "";
  let text = "";
  for await (const event of provider.stream({
    model: "grok-4.5",
    messages: [textMessage("user", "hi")],
  })) {
    if (event.type === "thinking_delta") thinking += event.text;
    if (event.type === "text_delta") text += event.text;
  }
  assert.equal(thinking, "The problem asks 2+2.");
  assert.equal(text, "4");
});

test("non-streaming message.reasoning_content maps to a thinking part", async () => {
  const provider = new XAIOAuthProvider({
    credentials: { accessToken: "AT" },
    fetch: routedFetch({
      calls: [],
      onChat: () =>
        chatResponse(200, {
          choices: [
            {
              message: { content: "4", reasoning_content: "2+2 is 4." },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
    }),
  });
  const result = await provider.generate({
    model: "grok-4.5",
    messages: [textMessage("user", "hi")],
  });
  assert.deepEqual(result.message.content[0], { type: "thinking", text: "2+2 is 4." });
  assert.equal(result.text, "4");
});

test("caller-provided stream_options is not overridden", async () => {
  const sse = [
    'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  const calls: Call[] = [];
  const provider = new XAIOAuthProvider({
    credentials: { accessToken: "AT" },
    fetch: routedFetch({ calls, onChat: () => new Response(sse, { status: 200 }) }),
  });
  for await (
    const _ of provider.stream({
      model: "grok-4.5",
      messages: [textMessage("user", "hi")],
      providerOptions: { stream_options: { include_usage: false } },
    })
  ) {
    // drain
  }
  const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
  assert.deepEqual(body.stream_options, { include_usage: false });
});

test("non-streaming requests carry no stream_options", async () => {
  const calls: Call[] = [];
  const provider = new XAIOAuthProvider({
    credentials: { accessToken: "AT" },
    fetch: routedFetch({ calls, onChat: () => chatResponse() }),
  });
  await provider.generate({ model: "grok-4.5", messages: [textMessage("user", "hi")] });
  const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
  assert.equal(body.stream_options, undefined);
});

test("subscriptionUsage: format=credits maps weekly pool into rateLimit.sevenDay", async () => {
  const calls: Call[] = [];
  const creditsBody = {
    config: {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-07-08T00:00:00+00:00",
        end: "2026-07-15T00:00:00+00:00",
      },
      creditUsagePercent: 31,
      productUsage: [
        { product: "GrokBuild", usagePercent: 31 },
        { product: "GrokChat" },
      ],
      isUnifiedBillingUser: true,
      prepaidBalance: { val: 0 },
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 },
      billingPeriodStart: "2026-07-08T00:00:00+00:00",
      billingPeriodEnd: "2026-07-15T00:00:00+00:00",
    },
  };
  const provider = new XAIOAuthProvider({
    credentials: { accessToken: "AT" },
    fetch: async (input, init) => {
      const url = String(input);
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      calls.push({ url, headers, body: String(init?.body ?? "") });
      if (url.includes("/v1/billing")) {
        return new Response(JSON.stringify(creditsBody), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return chatResponse();
    },
  });

  const usage = await provider.subscriptionUsage();
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/v1\/billing\?format=credits$/);
  assert.equal(calls[0]!.headers["authorization"], "Bearer AT");
  assert.equal(usage.percent, 31);
  assert.equal(usage.utilization, 0.31);
  assert.equal(usage.periodType, "USAGE_PERIOD_TYPE_WEEKLY");
  assert.equal(usage.periodStart, Date.parse("2026-07-08T00:00:00+00:00"));
  assert.equal(usage.periodEnd, Date.parse("2026-07-15T00:00:00+00:00"));
  assert.equal(usage.products.length, 2);
  assert.equal(usage.products[0]!.product, "GrokBuild");
  assert.equal(usage.products[0]!.usagePercent, 31);
  assert.equal(usage.isUnified, true);

  assert.equal(usage.rateLimit.representative, "seven_day");
  assert.equal(usage.rateLimit.sevenDay?.utilization, 0.31);
  assert.equal(usage.rateLimit.sevenDay?.status, "allowed");
  assert.equal(usage.rateLimit.resetAt, usage.periodEnd);
  // Cached for pool / Provider.rateLimit readers
  assert.equal(provider.rateLimit?.sevenDay?.utilization, 0.31);
});

test("subscriptionUsage: high utilization marks allowed_warning / rejected", async () => {
  const mk = (percent: number) =>
    new XAIOAuthProvider({
      credentials: { accessToken: "AT" },
      fetch: async () =>
        new Response(
          JSON.stringify({
            config: {
              currentPeriod: {
                type: "USAGE_PERIOD_TYPE_WEEKLY",
                start: "2026-07-08T00:00:00+00:00",
                end: "2026-07-15T00:00:00+00:00",
              },
              creditUsagePercent: percent,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });

  const warn = await mk(95).subscriptionUsage();
  assert.equal(warn.rateLimit.status, "allowed_warning");
  const rej = await mk(100).subscriptionUsage();
  assert.equal(rej.rateLimit.status, "rejected");
});

test("subscriptionUsage: HTTP errors become CardanError", async () => {
  const provider = new XAIOAuthProvider({
    credentials: { accessToken: "AT" },
    fetch: async () => new Response("nope", { status: 503 }),
  });
  await assert.rejects(
    provider.subscriptionUsage(),
    (err: Error) => /subscription usage.*503/i.test(err.message),
  );
});
