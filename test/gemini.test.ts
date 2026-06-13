import { test } from "node:test";
import assert from "node:assert/strict";

import { GeminiProvider } from "../src/providers/gemini.js";
import { CardanError, collectStream, textMessage } from "../src/index.js";
import type { Message } from "../src/index.js";

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

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const RESPONSE_FIXTURE = {
  candidates: [
    {
      content: { role: "model", parts: [{ text: "hi" }] },
      finishReason: "STOP",
    },
  ],
  usageMetadata: {
    promptTokenCount: 100,
    candidatesTokenCount: 5,
    thoughtsTokenCount: 7,
    cachedContentTokenCount: 40,
    totalTokenCount: 112,
  },
  modelVersion: "gemini-2.5-flash",
};

test("builds request: url, headers, system hoist, tools, toolConfig, generationConfig", async () => {
  const captured: Captured[] = [];
  const provider = new GeminiProvider({
    apiKey: "g-test",
    fetch: mockFetch([() => jsonResponse(RESPONSE_FIXTURE)], captured),
  });

  const messages: Message[] = [
    textMessage("system", "be terse"),
    textMessage("user", "q"),
    textMessage("system", "mid-conversation note"),
    textMessage("user", "next"),
  ];

  await provider.generate({
    model: "gemini-2.5-flash",
    messages,
    temperature: 0.5,
    maxOutputTokens: 1000,
    stopSequences: ["END"],
    tools: [{ name: "f", description: "d", parameters: { type: "object" } }],
    toolChoice: { name: "f" },
  });

  const request = captured[0]!;
  assert.equal(
    request.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
  );
  assert.equal(request.headers["x-goog-api-key"], "g-test");

  const body = request.body;
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "be terse" }] });
  assert.deepEqual(body.generationConfig, {
    maxOutputTokens: 1000,
    temperature: 0.5,
    stopSequences: ["END"],
  });
  assert.deepEqual(body.tools, [
    {
      functionDeclarations: [
        { name: "f", description: "d", parametersJsonSchema: { type: "object" } },
      ],
    },
  ]);
  assert.deepEqual(body.toolConfig, {
    functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["f"] },
  });
  // mid-conversation system downgraded to user text, merged with next user turn
  assert.deepEqual(body.contents, [
    {
      role: "user",
      parts: [{ text: "q" }, { text: "mid-conversation note" }, { text: "next" }],
    },
  ]);
});

test("replays tool calls: synthetic ids stripped, real ids and signatures kept", async () => {
  const captured: Captured[] = [];
  const provider = new GeminiProvider({
    apiKey: "g-test",
    fetch: mockFetch([() => jsonResponse(RESPONSE_FIXTURE)], captured),
  });

  const messages: Message[] = [
    textMessage("user", "q"),
    {
      role: "assistant",
      content: [
        { type: "tool_call", id: "cardan_call_1", name: "f", args: { x: 1 } },
        { type: "tool_call", id: "fc_real", name: "g", args: { y: 2 }, signature: "sig1" },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool_result", callId: "cardan_call_1", result: "plain text" },
        { type: "tool_result", callId: "fc_real", result: { ok: true }, isError: false },
      ],
    },
  ];

  await provider.generate({ model: "gemini-3.5-flash", messages });

  const contents = captured[0]!.body.contents as Array<{ role: string; parts: unknown[] }>;
  assert.deepEqual(
    contents.map((content) => content.role),
    ["user", "model", "user"],
  );
  assert.deepEqual(contents[1]!.parts, [
    { functionCall: { name: "f", args: { x: 1 } } },
    { functionCall: { id: "fc_real", name: "g", args: { y: 2 } }, thoughtSignature: "sig1" },
  ]);
  // non-object results wrapped; name resolved from the matching tool_call
  assert.deepEqual(contents[2]!.parts, [
    { functionResponse: { name: "f", response: { result: "plain text" } } },
    { functionResponse: { id: "fc_real", name: "g", response: { ok: true } } },
  ]);
});

test("tool errors and signed text/thinking parts convert correctly", async () => {
  const captured: Captured[] = [];
  const provider = new GeminiProvider({
    apiKey: "g-test",
    fetch: mockFetch([() => jsonResponse(RESPONSE_FIXTURE)], captured),
  });

  const messages: Message[] = [
    textMessage("user", "q"),
    {
      role: "assistant",
      content: [
        { type: "thinking", text: "unsigned summary" },
        { type: "thinking", text: "signed", signature: "tsig" },
        { type: "thinking", text: "", signature: "opaque", redacted: true },
        { type: "text", text: "answer", signature: "textsig" },
        { type: "tool_call", id: "cardan_call_2", name: "f", args: {} },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool_result", callId: "cardan_call_2", result: { a: 1 }, isError: true },
      ],
    },
  ];

  await provider.generate({ model: "gemini-3.5-flash", messages });

  const contents = captured[0]!.body.contents as Array<{ role: string; parts: unknown[] }>;
  // unsigned + redacted thinking dropped; signed thinking and text keep signatures
  assert.deepEqual(contents[1]!.parts, [
    { text: "signed", thought: true, thoughtSignature: "tsig" },
    { text: "answer", thoughtSignature: "textsig" },
    { functionCall: { name: "f", args: {} } },
  ]);
  assert.deepEqual(contents[2]!.parts, [
    { functionResponse: { name: "f", response: { error: '{"a":1}' } } },
  ]);
});

test("thinking config: gemini-3 level vs gemini-2.5 budget", async () => {
  const captured: Captured[] = [];
  const provider = new GeminiProvider({
    apiKey: "g-test",
    fetch: mockFetch([() => jsonResponse(RESPONSE_FIXTURE)], captured),
  });
  const base = { messages: [textMessage("user", "q")] };

  await provider.generate({ ...base, model: "gemini-3.5-flash", reasoning: { enabled: true, effort: "xhigh" } });
  await provider.generate({ ...base, model: "gemini-2.5-flash", reasoning: { enabled: true, effort: "low" } });
  await provider.generate({ ...base, model: "gemini-2.5-flash", reasoning: { enabled: false } });
  await provider.generate({ ...base, model: "gemini-3.5-flash", reasoning: { enabled: false } });
  // effort without `enabled` implies enabled, and thoughts are still surfaced
  await provider.generate({ ...base, model: "gemini-3.5-flash", reasoning: { effort: "high" } });
  await provider.generate({ ...base, model: "gemini-2.5-flash", reasoning: { effort: "low" } });

  const configs = captured.map(
    (request) => (request.body.generationConfig as { thinkingConfig?: unknown })?.thinkingConfig,
  );
  assert.deepEqual(configs[0], { includeThoughts: true, thinkingLevel: "high" });
  assert.deepEqual(configs[1], { includeThoughts: true, thinkingBudget: 1024 });
  assert.deepEqual(configs[2], { thinkingBudget: 0 });
  assert.deepEqual(configs[3], { thinkingLevel: "minimal" });
  assert.deepEqual(configs[4], { includeThoughts: true, thinkingLevel: "high" });
  assert.deepEqual(configs[5], { includeThoughts: true, thinkingBudget: 1024 });
});

test("parses response: parts, synthetic call id, finish reason, usage", async () => {
  const provider = new GeminiProvider({
    apiKey: "g-test",
    fetch: mockFetch([
      () =>
        jsonResponse({
          ...RESPONSE_FIXTURE,
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  { text: "let me think", thought: true },
                  { text: "calling", thoughtSignature: "ts1" },
                  { functionCall: { name: "get_weather", args: { city: "SF" } }, thoughtSignature: "ts2" },
                ],
              },
              finishReason: "STOP",
            },
          ],
        }),
    ]),
  });
  const result = await provider.generate({
    model: "gemini-2.5-flash",
    messages: [textMessage("user", "q")],
  });

  const parts = result.message.content;
  assert.deepEqual(parts[0], { type: "thinking", text: "let me think" });
  assert.deepEqual(parts[1], { type: "text", text: "calling", signature: "ts1" });
  assert.equal(parts[2]!.type, "tool_call");
  const call = parts[2] as { id: string; name: string; args: unknown; signature?: string };
  assert.ok(call.id.startsWith("cardan_call_"));
  assert.equal(call.name, "get_weather");
  assert.deepEqual(call.args, { city: "SF" });
  assert.equal(call.signature, "ts2");
  // STOP + functionCall present → tool_calls
  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.usage.input.total, 100);
  assert.deepEqual(result.usage.input.details, { cache_read: 40 });
  assert.equal(result.usage.output.total, 12);
  assert.deepEqual(result.usage.output.details, { reasoning: 7 });
});

test("blocked prompt yields refusal with empty message", async () => {
  const provider = new GeminiProvider({
    apiKey: "g-test",
    fetch: mockFetch([
      () =>
        jsonResponse({
          promptFeedback: { blockReason: "SAFETY" },
          usageMetadata: { promptTokenCount: 9 },
        }),
    ]),
  });
  const result = await provider.generate({
    model: "gemini-2.5-flash",
    messages: [textMessage("user", "q")],
  });
  assert.equal(result.finishReason, "refusal");
  assert.deepEqual(result.message.content, []);
});

test("structured output sets responseJsonSchema and parses JSON", async () => {
  const captured: Captured[] = [];
  const provider = new GeminiProvider({
    apiKey: "g-test",
    fetch: mockFetch(
      [
        () =>
          jsonResponse({
            ...RESPONSE_FIXTURE,
            candidates: [
              {
                content: { role: "model", parts: [{ text: '{"name":"Jane"}' }] },
                finishReason: "STOP",
              },
            ],
          }),
      ],
      captured,
    ),
  });
  const schema = { type: "object", properties: { name: { type: "string" } } };
  const result = await provider.generate({
    model: "gemini-2.5-flash",
    messages: [textMessage("user", "extract")],
    output: { schema },
  });
  const generationConfig = captured[0]!.body.generationConfig as Record<string, unknown>;
  assert.equal(generationConfig.responseMimeType, "application/json");
  assert.deepEqual(generationConfig.responseJsonSchema, schema);
  assert.deepEqual(result.output, { name: "Jane" });
});

test("maps HTTP errors: context length and RetryInfo retryDelay", async () => {
  const captured: Captured[] = [];
  const provider = new GeminiProvider({
    apiKey: "g-test",
    fetch: mockFetch(
      [
        () =>
          jsonResponse(
            {
              error: {
                code: 429,
                message: "Resource has been exhausted",
                status: "RESOURCE_EXHAUSTED",
                details: [
                  {
                    "@type": "type.googleapis.com/google.rpc.RetryInfo",
                    retryDelay: "0.01s",
                  },
                ],
              },
            },
            429,
          ),
        () => jsonResponse(RESPONSE_FIXTURE),
      ],
      captured,
    ),
  });
  const result = await provider.generate({
    model: "gemini-2.5-flash",
    messages: [textMessage("user", "q")],
    retry: { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 5 },
  });
  assert.equal(captured.length, 2);
  assert.equal(result.finishReason, "stop");

  const tooLong = new GeminiProvider({
    apiKey: "g-test",
    fetch: mockFetch([
      () =>
        jsonResponse(
          {
            error: {
              code: 400,
              message: "The input token count (2000000) exceeds the maximum number of tokens allowed (1048576).",
              status: "INVALID_ARGUMENT",
            },
          },
          400,
        ),
    ]),
  });
  await assert.rejects(
    tooLong.generate({ model: "gemini-2.5-flash", messages: [textMessage("user", "q")] }),
    (error: unknown) =>
      error instanceof CardanError && error.code === "context_length" && error.status === 400,
  );
});

const STREAM_FIXTURE = [
  `data: ${JSON.stringify({
    candidates: [{ content: { role: "model", parts: [{ text: "mull", thought: true }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0, thoughtsTokenCount: 3 },
  })}\n\n`,
  `data: ${JSON.stringify({
    candidates: [{ content: { role: "model", parts: [{ text: "He" }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1, thoughtsTokenCount: 3 },
  })}\n\n`,
  `data: ${JSON.stringify({
    candidates: [{ content: { role: "model", parts: [{ text: "llo" }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 3 },
  })}\n\n`,
  `data: ${JSON.stringify({
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            {
              functionCall: { id: "fc_9", name: "get_weather", args: { city: "SF" } },
              thoughtSignature: "sig9",
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 8, thoughtsTokenCount: 3 },
  })}\n\n`,
].join("");

test("streams: thinking/text deltas, tool call with signature, cumulative usage", async () => {
  const provider = new GeminiProvider({
    apiKey: "g-test",
    fetch: mockFetch([
      () =>
        new Response(STREAM_FIXTURE, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    ]),
  });
  const stream = provider.stream({
    model: "gemini-2.5-flash",
    messages: [textMessage("user", "q")],
  });
  const result = await collectStream(stream);
  assert.deepEqual(result.message.content, [
    { type: "thinking", text: "mull" },
    { type: "text", text: "Hello" },
    {
      type: "tool_call",
      id: "fc_9",
      name: "get_weather",
      args: { city: "SF" },
      signature: "sig9",
    },
  ]);
  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.usage.input.total, 10);
  assert.equal(result.usage.output.total, 11);
  assert.deepEqual(result.usage.output.details, { reasoning: 3 });
});

test("stream without finishReason raises network error", async () => {
  const sse = `data: ${JSON.stringify({
    candidates: [{ content: { role: "model", parts: [{ text: "partial" }] } }],
  })}\n\n`;
  const provider = new GeminiProvider({
    apiKey: "g-test",
    fetch: mockFetch([() => new Response(sse, { status: 200 })]),
  });
  await assert.rejects(
    collectStream(
      provider.stream({ model: "gemini-2.5-flash", messages: [textMessage("user", "q")] }),
    ),
    (error: unknown) => error instanceof CardanError && error.code === "network",
  );
});

test("embed: batchEmbedContents request shape and response parsing", async () => {
  const captured: Captured[] = [];
  const provider = new GeminiProvider({
    apiKey: "g-test",
    fetch: mockFetch(
      [() => jsonResponse({ embeddings: [{ values: [0.1, 0.2] }, { values: [0.3] }] })],
      captured,
    ),
  });
  const result = await provider.embed({
    model: "gemini-embedding-001",
    input: ["a", "b"],
    providerOptions: { taskType: "SEMANTIC_SIMILARITY" },
  });
  const request = captured[0]!;
  assert.equal(
    request.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents",
  );
  assert.deepEqual(request.body.requests, [
    {
      model: "models/gemini-embedding-001",
      content: { parts: [{ text: "a" }] },
      taskType: "SEMANTIC_SIMILARITY",
    },
    {
      model: "models/gemini-embedding-001",
      content: { parts: [{ text: "b" }] },
      taskType: "SEMANTIC_SIMILARITY",
    },
  ]);
  assert.deepEqual(result.embeddings, [[0.1, 0.2], [0.3]]);
});

test("image parts: bytes to inlineData, URL to fileData", async () => {
  const captured: Captured[] = [];
  const provider = new GeminiProvider({
    apiKey: "g-test",
    fetch: mockFetch([() => jsonResponse(RESPONSE_FIXTURE)], captured),
  });
  await provider.generate({
    model: "gemini-2.5-flash",
    messages: [
      {
        role: "user",
        content: [
          { type: "image", mimeType: "image/png", data: new Uint8Array([1, 2, 3]) },
          {
            type: "image",
            mimeType: "video/mp4",
            data: new URL("https://generativelanguage.googleapis.com/v1beta/files/abc"),
          },
        ],
      },
    ],
  });
  const contents = captured[0]!.body.contents as Array<{ parts: unknown[] }>;
  assert.deepEqual(contents[0]!.parts, [
    { inlineData: { mimeType: "image/png", data: "AQID" } },
    {
      fileData: {
        mimeType: "video/mp4",
        fileUri: "https://generativelanguage.googleapis.com/v1beta/files/abc",
      },
    },
  ]);
});
