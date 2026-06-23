import { test } from "node:test";
import assert from "node:assert/strict";

import { ModalProvider } from "../src/providers/modal.js";
import { CardanError, collectStream, createCardan, textMessage } from "../src/index.js";

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function mockFetch(
  responses: Array<() => Response>,
  captured: Captured[] = [],
): typeof globalThis.fetch {
  let call = 0;
  return async (input, init) => {
    captured.push({
      url: String(input),
      headers: { ...(init?.headers as Record<string, string>) },
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const next = responses[Math.min(call, responses.length - 1)]!;
    call++;
    return next();
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const BASE_URL = "https://workspace--vllm-serve.modal.run";

const CHAT_FIXTURE = {
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "qwen3-32b",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "hi" },
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: 40,
    prompt_tokens_details: { cached_tokens: 16 },
    completion_tokens: 8,
    completion_tokens_details: { reasoning_tokens: 5 },
  },
};

test("targets the deployment's chat completions endpoint with both auth schemes", async () => {
  const captured: Captured[] = [];
  const provider = new ModalProvider({
    baseUrl: `${BASE_URL}/`,
    apiKey: "vllm-key",
    proxyAuth: { tokenId: "wk-1", tokenSecret: "ws-1" },
    fetch: mockFetch([() => jsonResponse(CHAT_FIXTURE)], captured),
  });
  const result = await provider.generate({
    model: "qwen3-32b",
    messages: [textMessage("system", "sys"), textMessage("user", "q")],
    maxOutputTokens: 100,
    temperature: 0.5,
    topP: 0.9,
    stopSequences: ["END"],
  });
  const request = captured[0]!;
  assert.equal(request.url, `${BASE_URL}/v1/chat/completions`);
  assert.equal(request.headers.authorization, "Bearer vllm-key");
  assert.equal(request.headers["Modal-Key"], "wk-1");
  assert.equal(request.headers["Modal-Secret"], "ws-1");
  assert.deepEqual(request.body.messages, [
    { role: "system", content: "sys" },
    { role: "user", content: "q" },
  ]);
  assert.equal(request.body.max_tokens, 100);
  assert.equal(request.body.temperature, 0.5);
  assert.equal(request.body.top_p, 0.9);
  assert.deepEqual(request.body.stop, ["END"]);
  assert.equal(request.body.stream, undefined);
  assert.deepEqual(result.message.content, [{ type: "text", text: "hi" }]);
  assert.equal(result.finishReason, "stop");
  assert.equal(result.usage.input.total, 40);
  assert.deepEqual(result.usage.input.details, { cache_read: 16 });
  assert.equal(result.usage.output.total, 8);
  assert.deepEqual(result.usage.output.details, { reasoning: 5 });
});

test("defaults to the us-west-2 Modal gateway when no URL is set", async () => {
  const captured: Captured[] = [];
  const provider = new ModalProvider({
    fetch: mockFetch([() => jsonResponse(CHAT_FIXTURE)], captured),
  });
  await provider.generate({ model: "m", messages: [textMessage("user", "q")] });
  assert.equal(
    captured[0]!.url,
    "https://api.us-west-2.modal.direct/v1/chat/completions",
  );
});

test("converts tools, named tool choice, and replayed tool turns", async () => {
  const captured: Captured[] = [];
  const provider = new ModalProvider({
    baseUrl: BASE_URL,
    fetch: mockFetch([() => jsonResponse(CHAT_FIXTURE)], captured),
  });
  await provider.generate({
    model: "qwen3-32b",
    messages: [
      textMessage("user", "weather?"),
      {
        role: "assistant",
        content: [
          // thinking is not replayable in Chat Completions and must drop
          { type: "thinking", text: "hmm" },
          { type: "text", text: "checking" },
          { type: "tool_call", id: "call_1", name: "get_weather", args: { city: "tokyo" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", callId: "call_1", result: { temp: 21 } }],
      },
    ],
    tools: [
      {
        name: "get_weather",
        description: "look up weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    ],
    toolChoice: { name: "get_weather" },
  });
  const body = captured[0]!.body;
  assert.deepEqual(body.tools, [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "look up weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    },
  ]);
  assert.deepEqual(body.tool_choice, {
    type: "function",
    function: { name: "get_weather" },
  });
  assert.deepEqual(body.messages, [
    { role: "user", content: "weather?" },
    {
      role: "assistant",
      content: "checking",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"tokyo"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: '{"temp":21}' },
  ]);
});

test("maps reasoning_content and tool calls out of the response", async () => {
  const provider = new ModalProvider({
    baseUrl: BASE_URL,
    fetch: mockFetch([
      () =>
        jsonResponse({
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "calling",
                reasoning_content: "let me think",
                tool_calls: [
                  {
                    id: "call_9",
                    type: "function",
                    function: { name: "lookup", arguments: '{"q":1}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
    ]),
  });
  const result = await provider.generate({
    model: "qwen3-32b",
    messages: [textMessage("user", "q")],
  });
  assert.deepEqual(result.message.content, [
    { type: "thinking", text: "let me think" },
    { type: "text", text: "calling" },
    { type: "tool_call", id: "call_9", name: "lookup", args: { q: 1 } },
  ]);
  assert.equal(result.finishReason, "tool_calls");
});

test("maps reasoning effort to reasoning_effort, capped at high", async () => {
  const captured: Captured[] = [];
  const provider = new ModalProvider({
    baseUrl: BASE_URL,
    fetch: mockFetch([() => jsonResponse(CHAT_FIXTURE)], captured),
  });
  const generate = (reasoning: { enabled?: boolean; effort?: "max" | "medium" }) =>
    provider.generate({
      model: "qwen3-32b",
      messages: [textMessage("user", "q")],
      reasoning,
    });
  await generate({ effort: "max" });
  await generate({ effort: "medium" });
  // `enabled` has no generic Chat Completions mapping; nothing is sent
  await generate({ enabled: false, effort: "medium" });
  assert.equal(captured[0]!.body.reasoning_effort, "high");
  assert.equal(captured[1]!.body.reasoning_effort, "medium");
  assert.equal(captured[2]!.body.reasoning_effort, undefined);
});

test("requests structured output via response_format json_schema", async () => {
  const captured: Captured[] = [];
  const schema = {
    type: "object",
    properties: { answer: { type: "number" } },
    required: ["answer"],
  };
  const provider = new ModalProvider({
    baseUrl: BASE_URL,
    fetch: mockFetch(
      [
        () =>
          jsonResponse({
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: '{"answer":42}' },
                finish_reason: "stop",
              },
            ],
          }),
      ],
      captured,
    ),
  });
  const result = await provider.generate({
    model: "qwen3-32b",
    messages: [textMessage("user", "q")],
    output: { schema },
  });
  assert.deepEqual(captured[0]!.body.response_format, {
    type: "json_schema",
    json_schema: { name: "output", strict: true, schema },
  });
  assert.deepEqual(result.output, { answer: 42 });
});

test("streams text, reasoning, fragmented tool calls, and usage", async () => {
  const chunks = [
    '{"choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"hm"}}]}',
    '{"choices":[{"index":0,"delta":{"content":"yo"}}]}',
    '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\"q\\""}}]}}]}',
    '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}}]}',
    '{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
    '{"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":4}}',
    "[DONE]",
  ];
  const sse = chunks.map((chunk) => `data: ${chunk}\n\n`).join("");
  const captured: Captured[] = [];
  const provider = new ModalProvider({
    baseUrl: BASE_URL,
    fetch: mockFetch([() => new Response(sse, { status: 200 })], captured),
  });
  const result = await collectStream(
    provider.stream({ model: "qwen3-32b", messages: [textMessage("user", "q")] }),
  );
  assert.equal(captured[0]!.body.stream, true);
  assert.deepEqual(captured[0]!.body.stream_options, { include_usage: true });
  assert.deepEqual(result.message.content, [
    { type: "thinking", text: "hm" },
    { type: "text", text: "yo" },
    { type: "tool_call", id: "call_1", name: "lookup", args: { q: 1 } },
  ]);
  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.usage.input.total, 7);
  assert.equal(result.usage.output.total, 4);
});

test("maps Modal proxy-auth plain-text 401 to an auth error", async () => {
  const provider = new ModalProvider({
    baseUrl: BASE_URL,
    retry: false,
    fetch: mockFetch([
      () =>
        new Response("modal-http: missing credentials for proxy authorization", {
          status: 401,
        }),
    ]),
  });
  await assert.rejects(
    provider.generate({ model: "m", messages: [textMessage("user", "q")] }),
    (error: unknown) =>
      error instanceof CardanError &&
      error.code === "auth" &&
      error.status === 401 &&
      error.message.includes("modal-http"),
  );
});

test("embed targets /v1/embeddings on the deployment", async () => {
  const captured: Captured[] = [];
  const provider = new ModalProvider({
    baseUrl: BASE_URL,
    fetch: mockFetch(
      [
        () =>
          jsonResponse({
            data: [
              { index: 1, embedding: [3, 4] },
              { index: 0, embedding: [1, 2] },
            ],
            usage: { prompt_tokens: 6 },
          }),
      ],
      captured,
    ),
  });
  const result = await provider.embed({ model: "bge-m3", input: ["a", "b"] });
  assert.equal(captured[0]!.url, `${BASE_URL}/v1/embeddings`);
  assert.deepEqual(result.embeddings, [
    [1, 2],
    [3, 4],
  ]);
  assert.equal(result.usage.input.total, 6);
});

test("Cardan routes modal/ model ids to the Modal provider", async () => {
  const captured: Captured[] = [];
  const cardan = createCardan({
    modal: {
      baseUrl: BASE_URL,
      fetch: mockFetch([() => jsonResponse(CHAT_FIXTURE)], captured),
    },
  });
  await cardan.generate({
    model: "modal/qwen3-32b",
    messages: [textMessage("user", "q")],
  });
  assert.equal(captured[0]!.url, `${BASE_URL}/v1/chat/completions`);
  assert.equal(captured[0]!.body.model, "qwen3-32b");
});

test("web search: rejected — no built-in web search on Modal", async () => {
  const provider = new ModalProvider({
    baseUrl: "https://x--app.modal.run",
    fetch: mockFetch([() => jsonResponse(CHAT_FIXTURE)]),
  });
  await assert.rejects(
    provider.generate({
      model: "my-model",
      messages: [textMessage("user", "q")],
      webSearch: true,
    }),
    (error: unknown) =>
      error instanceof CardanError && error.code === "invalid_request",
  );
});
