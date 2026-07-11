import { test } from "node:test";
import assert from "node:assert/strict";

import { GroqProvider } from "../src/providers/groq.js";
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

const CHAT_FIXTURE = {
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "openai/gpt-oss-120b",
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

test("targets api.groq.com chat completions with sampling params and stop", async () => {
  const captured: Captured[] = [];
  const provider = new GroqProvider({
    apiKey: "gsk-test",
    fetch: mockFetch([() => jsonResponse(CHAT_FIXTURE)], captured),
  });
  const result = await provider.generate({
    model: "llama-3.3-70b-versatile",
    messages: [textMessage("system", "sys"), textMessage("user", "q")],
    maxOutputTokens: 100,
    temperature: 0.5,
    topP: 0.9,
    stopSequences: ["END"],
  });
  const request = captured[0]!;
  assert.equal(request.url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(request.headers.authorization, "Bearer gsk-test");
  assert.deepEqual(request.body.messages, [
    { role: "system", content: "sys" },
    { role: "user", content: "q" },
  ]);
  assert.equal(request.body.max_completion_tokens, 100);
  assert.equal(request.body.temperature, 0.5);
  assert.equal(request.body.top_p, 0.9);
  assert.deepEqual(request.body.stop, ["END"]);
  // non-reasoning models must not receive reasoning_format
  assert.equal(request.body.reasoning_format, undefined);
  assert.deepEqual(result.message.content, [{ type: "text", text: "hi" }]);
  assert.equal(result.finishReason, "stop");
  assert.equal(result.usage.input.total, 40);
  assert.deepEqual(result.usage.input.details, { cache_read: 16 });
  assert.equal(result.usage.output.total, 8);
  assert.deepEqual(result.usage.output.details, { reasoning: 5 });
});

test("always requests parsed reasoning on reasoning models", async () => {
  const captured: Captured[] = [];
  const provider = new GroqProvider({
    apiKey: "gsk-test",
    fetch: mockFetch([() => jsonResponse(CHAT_FIXTURE)], captured),
  });
  await provider.generate({
    model: "openai/gpt-oss-120b",
    messages: [textMessage("user", "q")],
  });
  await provider.generate({
    model: "qwen/qwen3-32b",
    messages: [textMessage("user", "q")],
  });
  assert.equal(captured[0]!.body.reasoning_format, "parsed");
  assert.equal(captured[1]!.body.reasoning_format, "parsed");
});

test("maps reasoning effort per model family", async () => {
  const captured: Captured[] = [];
  const provider = new GroqProvider({
    apiKey: "gsk-test",
    fetch: mockFetch([() => jsonResponse(CHAT_FIXTURE)], captured),
  });
  const generate = (
    model: string,
    reasoning: { enabled?: boolean; effort?: "max" | "medium" },
  ) =>
    provider.generate({
      model,
      messages: [textMessage("user", "q")],
      reasoning,
    });
  // gpt-oss grades low/medium/high; max caps to high
  await generate("openai/gpt-oss-120b", { effort: "max" });
  await generate("openai/gpt-oss-120b", { effort: "medium" });
  // qwen3 only knows none/default: graded efforts are omitted
  await generate("qwen/qwen3-32b", { effort: "medium" });
  // enabled: false maps to "none" (qwen3 accepts; gpt-oss rejects loudly)
  await generate("qwen/qwen3-32b", { enabled: false });
  // non-reasoning models reject reasoning_effort entirely — never send it,
  // even when the caller asks to disable reasoning
  await generate("llama-3.3-70b-versatile", { enabled: false });
  await generate("llama-3.3-70b-versatile", { effort: "medium" });
  assert.equal(captured[0]!.body.reasoning_effort, "high");
  assert.equal(captured[1]!.body.reasoning_effort, "medium");
  assert.equal(captured[2]!.body.reasoning_effort, undefined);
  assert.equal(captured[3]!.body.reasoning_effort, "none");
  assert.equal(captured[4]!.body.reasoning_effort, undefined);
  assert.equal(captured[5]!.body.reasoning_effort, undefined);
});

test("converts tools, named tool choice, and replayed tool turns", async () => {
  const captured: Captured[] = [];
  const provider = new GroqProvider({
    apiKey: "gsk-test",
    fetch: mockFetch([() => jsonResponse(CHAT_FIXTURE)], captured),
  });
  await provider.generate({
    model: "openai/gpt-oss-120b",
    messages: [
      textMessage("user", "weather?"),
      {
        role: "assistant",
        content: [
          // thinking has no Chat Completions replay format and must drop
          { type: "thinking", text: "hmm" },
          { type: "text", text: "checking" },
          { type: "tool_call", id: "fc_1", name: "get_weather", args: { city: "tokyo" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", callId: "fc_1", result: { temp: 21 } }],
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
          id: "fc_1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"tokyo"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "fc_1", content: '{"temp":21}' },
  ]);
});

test("maps message.reasoning and tool calls out of the response", async () => {
  const provider = new GroqProvider({
    apiKey: "gsk-test",
    fetch: mockFetch([
      () =>
        jsonResponse({
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "calling",
                reasoning: "let me think",
                tool_calls: [
                  {
                    id: "fc_9",
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
    model: "openai/gpt-oss-120b",
    messages: [textMessage("user", "q")],
  });
  assert.deepEqual(result.message.content, [
    { type: "thinking", text: "let me think" },
    { type: "text", text: "calling" },
    { type: "tool_call", id: "fc_9", name: "lookup", args: { q: 1 } },
  ]);
  assert.equal(result.finishReason, "tool_calls");
});

test("gates structured-output strict mode on constrained-decoding models", async () => {
  const captured: Captured[] = [];
  const schema = {
    type: "object",
    properties: { answer: { type: "number" } },
    required: ["answer"],
  };
  const provider = new GroqProvider({
    apiKey: "gsk-test",
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
    model: "openai/gpt-oss-120b",
    messages: [textMessage("user", "q")],
    output: { schema },
  });
  await provider.generate({
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    messages: [textMessage("user", "q")],
    output: { schema },
  });
  assert.deepEqual(captured[0]!.body.response_format, {
    type: "json_schema",
    json_schema: { name: "output", strict: true, schema },
  });
  // best-effort mode elsewhere: no strict flag
  assert.deepEqual(captured[1]!.body.response_format, {
    type: "json_schema",
    json_schema: { name: "output", schema },
  });
  assert.deepEqual(result.output, { answer: 42 });
});

test("streams reasoning, text, tool calls, and final-chunk usage", async () => {
  const chunks = [
    '{"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}',
    '{"choices":[{"index":0,"delta":{"reasoning":"hm","channel":"analysis"}}]}',
    '{"choices":[{"index":0,"delta":{"content":"yo"}}]}',
    '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"fc_1","type":"function","function":{"name":"lookup","arguments":"{\\"q\\""}}]}}]}',
    '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}}]}',
    // Groq puts usage on the finish_reason chunk (also under x_groq.usage)
    '{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"x_groq":{"usage":{"prompt_tokens":7,"completion_tokens":4}},"usage":{"prompt_tokens":7,"completion_tokens":4,"completion_tokens_details":{"reasoning_tokens":2}}}',
    "[DONE]",
  ];
  const sse = chunks.map((chunk) => `data: ${chunk}\n\n`).join("");
  const captured: Captured[] = [];
  const provider = new GroqProvider({
    apiKey: "gsk-test",
    fetch: mockFetch([() => new Response(sse, { status: 200 })], captured),
  });
  const result = await collectStream(
    provider.stream({
      model: "openai/gpt-oss-120b",
      messages: [textMessage("user", "q")],
    }),
  );
  assert.equal(captured[0]!.body.stream, true);
  assert.deepEqual(result.message.content, [
    { type: "thinking", text: "hm" },
    { type: "text", text: "yo" },
    { type: "tool_call", id: "fc_1", name: "lookup", args: { q: 1 } },
  ]);
  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.usage.input.total, 7);
  assert.equal(result.usage.output.total, 4);
  assert.deepEqual(result.usage.output.details, { reasoning: 2 });
});

test("streams: emits finish when the server closes without a [DONE] sentinel", async () => {
  const chunks = [
    '{"choices":[{"index":0,"delta":{"content":"hi"}}]}',
    // final chunk carries finish_reason + usage, then the stream just closes
    '{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
  ];
  const sse = chunks.map((chunk) => `data: ${chunk}\n\n`).join("");
  const provider = new GroqProvider({
    apiKey: "gsk-test",
    fetch: mockFetch([() => new Response(sse, { status: 200 })]),
  });
  const result = await collectStream(
    provider.stream({
      model: "llama-3.3-70b-versatile",
      messages: [textMessage("user", "q")],
    }),
  );
  assert.deepEqual(result.message.content, [{ type: "text", text: "hi" }]);
  assert.equal(result.finishReason, "stop");
  assert.equal(result.usage.input.total, 3);
  assert.equal(result.usage.output.total, 1);
});

test("maps 413 request_too_large to context_length", async () => {
  const provider = new GroqProvider({
    apiKey: "gsk-test",
    retry: false,
    fetch: mockFetch([
      () =>
        jsonResponse(
          {
            error: {
              message: "Request too large for model",
              type: "invalid_request_error",
              code: "request_too_large",
            },
          },
          413,
        ),
    ]),
  });
  await assert.rejects(
    provider.generate({ model: "m", messages: [textMessage("user", "q")] }),
    (error: unknown) =>
      error instanceof CardanError &&
      error.code === "context_length" &&
      error.status === 413,
  );
});

test("embed reports invalid_request (Groq has no embeddings API)", async () => {
  const provider = new GroqProvider({ apiKey: "gsk-test" });
  await assert.rejects(
    provider.embed({ model: "m", input: ["a"] }),
    (error: unknown) =>
      error instanceof CardanError &&
      error.code === "invalid_request" &&
      error.provider === "groq",
  );
});

test("Cardan routes groq/ ids, keeping slashes in the model name", async () => {
  const captured: Captured[] = [];
  const cardan = createCardan({
    groq: {
      apiKey: "gsk-test",
      fetch: mockFetch([() => jsonResponse(CHAT_FIXTURE)], captured),
    },
  });
  await cardan.generate({
    model: "groq/openai/gpt-oss-120b",
    messages: [textMessage("user", "q")],
  });
  assert.equal(captured[0]!.url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(captured[0]!.body.model, "openai/gpt-oss-120b");
});

test("web search: gpt-oss declares the browser_search tool", async () => {
  const captured: Captured[] = [];
  const provider = new GroqProvider({
    apiKey: "gsk-test",
    fetch: mockFetch([() => jsonResponse(CHAT_FIXTURE)], captured),
  });
  await provider.generate({
    model: "openai/gpt-oss-120b",
    messages: [textMessage("user", "q")],
    webSearch: true,
  });
  assert.deepEqual(captured[0]!.body.tools, [{ type: "browser_search" }]);
});

test("web search: browser_search is incompatible with structured output", async () => {
  const provider = new GroqProvider({
    apiKey: "gsk-test",
    fetch: mockFetch([() => jsonResponse(CHAT_FIXTURE)]),
  });
  await assert.rejects(
    provider.generate({
      model: "openai/gpt-oss-120b",
      messages: [textMessage("user", "q")],
      webSearch: true,
      output: { schema: { type: "object" } },
    }),
    (error: unknown) =>
      error instanceof CardanError && error.code === "invalid_request",
  );
});

test("web search: compound systems declare no tool and extract citations", async () => {
  const captured: Captured[] = [];
  const provider = new GroqProvider({
    apiKey: "gsk-test",
    fetch: mockFetch(
      [
        () =>
          jsonResponse({
            ...CHAT_FIXTURE,
            model: "groq/compound",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "answer",
                  executed_tools: [
                    {
                      type: "web_search",
                      search_results: {
                        results: [{ url: "https://a.com", title: "A", content: "snippet" }],
                      },
                    },
                  ],
                },
                finish_reason: "stop",
              },
            ],
          }),
      ],
      captured,
    ),
  });
  const result = await provider.generate({
    model: "groq/compound",
    messages: [textMessage("user", "q")],
    webSearch: true,
  });
  // compound runs search automatically — no tool is declared
  assert.equal(captured[0]!.body.tools, undefined);
  assert.deepEqual(result.citations, [
    { url: "https://a.com", title: "A", snippet: "snippet" },
  ]);
});

test("web search: rejects models without web search", async () => {
  const provider = new GroqProvider({
    apiKey: "gsk-test",
    fetch: mockFetch([() => jsonResponse(CHAT_FIXTURE)]),
  });
  await assert.rejects(
    provider.generate({
      model: "llama-3.3-70b-versatile",
      messages: [textMessage("user", "q")],
      webSearch: true,
    }),
    (error: unknown) =>
      error instanceof CardanError && error.code === "invalid_request",
  );
});

test("x-ratelimit headers: parsed into result.rateLimit and the provider getter", async () => {
  const headers = {
    "content-type": "application/json",
    "x-ratelimit-limit-requests": "480",
    "x-ratelimit-remaining-requests": "479",
    "x-ratelimit-limit-tokens": "10000000",
    "x-ratelimit-remaining-tokens": "9999810",
    "x-ratelimit-reset-tokens": "2m59.56s",
  };
  const provider = new GroqProvider({
    apiKey: "gsk-test",
    fetch: mockFetch([
      () => new Response(JSON.stringify(CHAT_FIXTURE), { status: 200, headers }),
    ]),
  });
  assert.equal(provider.rateLimit, undefined);

  const before = Date.now();
  const result = await provider.generate({
    model: "openai/gpt-oss-120b",
    messages: [textMessage("user", "q")],
  });

  assert.deepEqual(result.rateLimit?.requests, { limit: 480, remaining: 479 });
  assert.equal(result.rateLimit?.tokens?.limit, 10_000_000);
  assert.equal(result.rateLimit?.tokens?.remaining, 9_999_810);
  // "2m59.56s" ≈ 179 560 ms from now
  const resetAt = result.rateLimit?.tokens?.resetAt ?? 0;
  assert.ok(resetAt >= before + 179_000 && resetAt <= Date.now() + 180_000);
  assert.deepEqual(provider.rateLimit, result.rateLimit);
});

test("x-ratelimit headers: attached to the stream finish event", async () => {
  const chunks = [
    '{"choices":[{"index":0,"delta":{"content":"yo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":4}}',
    "[DONE]",
  ];
  const sse = chunks.map((chunk) => `data: ${chunk}\n\n`).join("");
  const provider = new GroqProvider({
    apiKey: "gsk-test",
    fetch: mockFetch([
      () =>
        new Response(sse, {
          status: 200,
          headers: {
            "x-ratelimit-limit-requests": "480",
            "x-ratelimit-remaining-requests": "478",
          },
        }),
    ]),
  });
  let finishRateLimit: unknown;
  for await (const event of provider.stream({
    model: "openai/gpt-oss-120b",
    messages: [textMessage("user", "q")],
  })) {
    if (event.type === "finish") finishRateLimit = event.rateLimit;
  }
  assert.deepEqual(finishRateLimit, {
    requests: { limit: 480, remaining: 478 },
  });
  assert.deepEqual(provider.rateLimit, finishRateLimit);
});

test("responses without x-ratelimit headers leave rateLimit unset", async () => {
  const provider = new GroqProvider({
    apiKey: "gsk-test",
    fetch: mockFetch([() => jsonResponse(CHAT_FIXTURE)]),
  });
  const result = await provider.generate({
    model: "openai/gpt-oss-120b",
    messages: [textMessage("user", "q")],
  });
  assert.equal(result.rateLimit, undefined);
  assert.equal(provider.rateLimit, undefined);
});
