import { test } from "node:test";
import assert from "node:assert/strict";

import { OpenAIProvider } from "../src/providers/openai.js";
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
  id: "resp_1",
  object: "response",
  status: "completed",
  model: "gpt-5.5",
  output: [
    {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "hi", annotations: [] }],
    },
  ],
  usage: {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 60 },
    output_tokens: 25,
    output_tokens_details: { reasoning_tokens: 10 },
  },
};

test("builds request: input items, tool replay, defaults, headers", async () => {
  const captured: Captured[] = [];
  const provider = new OpenAIProvider({
    apiKey: "sk-test",
    fetch: mockFetch([() => jsonResponse(RESPONSE_FIXTURE)], captured),
  });

  const messages: Message[] = [
    textMessage("system", "be terse"),
    textMessage("user", "q"),
    {
      role: "assistant",
      content: [
        { type: "thinking", text: "plan", id: "rs_1", signature: "enc_1" },
        { type: "tool_call", id: "call_1", name: "f", args: { x: 1 } },
      ],
    },
    {
      role: "tool",
      content: [{ type: "tool_result", callId: "call_1", result: { ok: true } }],
    },
    textMessage("assistant", "done"),
    textMessage("user", "next"),
  ];

  await provider.generate({
    model: "gpt-5.5",
    messages,
    maxOutputTokens: 2000,
    tools: [{ name: "f", description: "d", parameters: { type: "object" } }],
    toolChoice: "required",
  });

  const request = captured[0]!;
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.headers.authorization, "Bearer sk-test");

  const body = request.body;
  assert.equal(body.store, false);
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.equal(body.max_output_tokens, 2000);
  assert.equal(body.tool_choice, "required");
  assert.deepEqual(body.tools, [
    {
      type: "function",
      name: "f",
      description: "d",
      parameters: { type: "object" },
      strict: false,
    },
  ]);

  assert.deepEqual(body.input, [
    { type: "message", role: "system", content: "be terse" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "q" }] },
    {
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "plan" }],
      encrypted_content: "enc_1",
    },
    { type: "function_call", call_id: "call_1", name: "f", arguments: '{"x":1}' },
    { type: "function_call_output", call_id: "call_1", output: '{"ok":true}' },
    { type: "message", role: "assistant", content: "done" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
  ]);
});

test("drops sampling params on reasoning models, keeps them on chat models", async () => {
  const captured: Captured[] = [];
  const provider = new OpenAIProvider({
    apiKey: "sk-test",
    fetch: mockFetch([() => jsonResponse(RESPONSE_FIXTURE)], captured),
  });
  await provider.generate({
    model: "gpt-5.5",
    messages: [textMessage("user", "q")],
    temperature: 0.5,
    topP: 0.9,
    reasoning: { enabled: true, effort: "max" },
  });
  await provider.generate({
    model: "gpt-5.5-chat-latest",
    messages: [textMessage("user", "q")],
    temperature: 0.5,
  });
  assert.equal(captured[0]!.body.temperature, undefined);
  assert.equal(captured[0]!.body.top_p, undefined);
  assert.deepEqual(captured[0]!.body.reasoning, { effort: "xhigh", summary: "auto" });
  assert.equal(captured[1]!.body.temperature, 0.5);
});

test("thinking parts without id or signature are not replayed", async () => {
  const captured: Captured[] = [];
  const provider = new OpenAIProvider({
    apiKey: "sk-test",
    fetch: mockFetch([() => jsonResponse(RESPONSE_FIXTURE)], captured),
  });
  await provider.generate({
    model: "gpt-5.5",
    messages: [
      textMessage("user", "q"),
      {
        role: "assistant",
        content: [
          // Anthropic-style thinking (signature, no item id) cannot replay here
          { type: "thinking", text: "foreign", signature: "anthropic_sig" },
          { type: "text", text: "a" },
        ],
      },
      textMessage("user", "next"),
    ],
  });
  const input = captured[0]!.body.input as Array<{ type: string }>;
  assert.deepEqual(
    input.map((item) => item.type),
    ["message", "message", "message"],
  );
});

test("parses response: parts, finish reason, usage details", async () => {
  const provider = new OpenAIProvider({
    apiKey: "sk-test",
    fetch: mockFetch([
      () =>
        jsonResponse({
          ...RESPONSE_FIXTURE,
          output: [
            {
              type: "reasoning",
              id: "rs_9",
              summary: [{ type: "summary_text", text: "hmm" }],
              encrypted_content: "enc_9",
            },
            ...RESPONSE_FIXTURE.output,
            {
              type: "function_call",
              id: "fc_1",
              call_id: "call_9",
              name: "get_weather",
              arguments: '{"location":"SF"}',
            },
          ],
        }),
    ]),
  });
  const result = await provider.generate({
    model: "gpt-5.5",
    messages: [textMessage("user", "q")],
  });
  assert.deepEqual(result.message.content, [
    { type: "thinking", text: "hmm", id: "rs_9", signature: "enc_9" },
    { type: "text", text: "hi" },
    { type: "tool_call", id: "call_9", name: "get_weather", args: { location: "SF" } },
  ]);
  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.usage.input.total, 100);
  assert.deepEqual(result.usage.input.details, { cache_read: 60 });
  assert.equal(result.usage.output.total, 25);
  assert.deepEqual(result.usage.output.details, { reasoning: 10 });
});

test("incomplete response maps to length finish reason", async () => {
  const provider = new OpenAIProvider({
    apiKey: "sk-test",
    fetch: mockFetch([
      () =>
        jsonResponse({
          ...RESPONSE_FIXTURE,
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        }),
    ]),
  });
  const result = await provider.generate({
    model: "gpt-5.5",
    messages: [textMessage("user", "q")],
  });
  assert.equal(result.finishReason, "length");
});

test("maps HTTP errors and detects context length", async () => {
  const captured: Captured[] = [];
  const provider = new OpenAIProvider({
    apiKey: "sk-test",
    fetch: mockFetch(
      [
        () =>
          jsonResponse(
            { error: { message: "slow down", type: "rate_limit_error" } },
            429,
            { "retry-after": "0" },
          ),
        () => jsonResponse(RESPONSE_FIXTURE),
      ],
      captured,
    ),
  });
  const result = await provider.generate({
    model: "gpt-5.5",
    messages: [textMessage("user", "q")],
    retry: { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 5 },
  });
  assert.equal(captured.length, 2);
  assert.equal(result.finishReason, "stop");

  const failing = new OpenAIProvider({
    apiKey: "sk-test",
    fetch: mockFetch([
      () =>
        jsonResponse(
          {
            error: {
              message: "Your input exceeds the context window of this model.",
              code: "context_length_exceeded",
            },
          },
          400,
        ),
    ]),
  });
  await assert.rejects(
    failing.generate({ model: "gpt-5.5", messages: [textMessage("user", "q")] }),
    (error: unknown) =>
      error instanceof CardanError &&
      error.code === "context_length" &&
      error.status === 400,
  );
});

const STREAM_FIXTURE = [
  'data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n',
  'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[]}}\n\n',
  'data: {"type":"response.reasoning_summary_text.delta","item_id":"rs_1","delta":"hm"}\n\n',
  'data: {"type":"response.reasoning_summary_text.delta","item_id":"rs_1","delta":"m"}\n\n',
  'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"hmm"}],"encrypted_content":"enc_1"}}\n\n',
  'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"msg_1","role":"assistant","content":[]}}\n\n',
  'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"He"}\n\n',
  'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"llo"}\n\n',
  'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"Hello"}]}}\n\n',
  'data: {"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"get_weather","arguments":""}}\n\n',
  'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"location\\":"}\n\n',
  'data: {"type":"response.function_call_arguments.done","item_id":"fc_1","name":"get_weather","arguments":"{\\"location\\": \\"SF\\"}"}\n\n',
  'data: {"type":"response.output_item.done","output_index":2,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"get_weather","arguments":"{\\"location\\": \\"SF\\"}"}}\n\n',
  'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"type":"reasoning","id":"rs_1","summary":[]},{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"Hello"}]},{"type":"function_call","id":"fc_1","call_id":"call_1","name":"get_weather","arguments":"{}"}],"usage":{"input_tokens":40,"output_tokens":12,"output_tokens_details":{"reasoning_tokens":4}}}}\n\n',
].join("");

test("streams: deltas, reasoning signature with id, tool calls, finish usage", async () => {
  const provider = new OpenAIProvider({
    apiKey: "sk-test",
    fetch: mockFetch([
      () =>
        new Response(STREAM_FIXTURE, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    ]),
  });
  const result = await collectStream(
    provider.stream({ model: "gpt-5.5", messages: [textMessage("user", "q")] }),
  );
  assert.deepEqual(result.message.content, [
    { type: "thinking", text: "hmm", signature: "enc_1", id: "rs_1" },
    { type: "text", text: "Hello" },
    { type: "tool_call", id: "call_1", name: "get_weather", args: { location: "SF" } },
  ]);
  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.usage.input.total, 40);
  assert.equal(result.usage.output.total, 12);
  assert.deepEqual(result.usage.output.details, { reasoning: 4 });
});

test("stream failure events raise CardanError", async () => {
  const sse =
    'data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n' +
    'data: {"type":"response.failed","response":{"id":"resp_1","status":"failed","error":{"code":"server_error","message":"boom"}}}\n\n';
  const provider = new OpenAIProvider({
    apiKey: "sk-test",
    fetch: mockFetch([() => new Response(sse, { status: 200 })]),
  });
  await assert.rejects(
    collectStream(
      provider.stream({ model: "gpt-5.5", messages: [textMessage("user", "q")] }),
    ),
    (error: unknown) =>
      error instanceof CardanError &&
      error.code === "server" &&
      error.message === "boom",
  );
});

test("stream error event uses top-level message (not bare stream error)", async () => {
  const sse =
    'data: {"type":"error","code":"server_error","message":"The server had an error"}\n\n';
  const provider = new OpenAIProvider({
    apiKey: "sk-test",
    fetch: mockFetch([() => new Response(sse, { status: 200 })]),
    retry: false,
  });
  await assert.rejects(
    collectStream(
      provider.stream({ model: "gpt-5.5", messages: [textMessage("user", "q")] }),
    ),
    (error: unknown) =>
      error instanceof CardanError &&
      error.code === "server" &&
      error.message === "The server had an error",
  );
});

test("structured output sets text.format and parses JSON", async () => {
  const captured: Captured[] = [];
  const provider = new OpenAIProvider({
    apiKey: "sk-test",
    fetch: mockFetch(
      [
        () =>
          jsonResponse({
            ...RESPONSE_FIXTURE,
            output: [
              {
                type: "message",
                id: "msg_1",
                role: "assistant",
                content: [{ type: "output_text", text: '{"name":"Jane"}' }],
              },
            ],
          }),
      ],
      captured,
    ),
  });
  const schema = { type: "object", properties: { name: { type: "string" } } };
  const result = await provider.generate({
    model: "gpt-5.5",
    messages: [textMessage("user", "extract")],
    output: { schema },
  });
  assert.deepEqual(captured[0]!.body.text, {
    format: { type: "json_schema", name: "output", strict: true, schema },
  });
  assert.deepEqual(result.output, { name: "Jane" });
});

test("structured output picks the final part when a reasoning model emits drafts", async () => {
  // Strict json_schema makes each text part valid JSON on its own, but a
  // reasoning model can emit several (intermediate drafts, then the answer).
  // Joining them is unparseable; the last part is the real answer.
  const provider = new OpenAIProvider({
    apiKey: "sk-test",
    fetch: mockFetch([
      () =>
        jsonResponse({
          ...RESPONSE_FIXTURE,
          output: [
            {
              type: "message",
              id: "msg_1",
              role: "assistant",
              content: [{ type: "output_text", text: '{"name":"draft"}' }],
            },
            {
              type: "message",
              id: "msg_2",
              role: "assistant",
              content: [{ type: "output_text", text: '{"name":"Jane"}' }],
            },
          ],
        }),
    ]),
  });
  const schema = { type: "object", properties: { name: { type: "string" } } };
  const result = await provider.generate({
    model: "gpt-5.5",
    messages: [textMessage("user", "extract")],
    output: { schema },
  });
  assert.deepEqual(result.output, { name: "Jane" });
});

test("refusal content maps to refusal finish reason", async () => {
  const provider = new OpenAIProvider({
    apiKey: "sk-test",
    fetch: mockFetch([
      () =>
        jsonResponse({
          ...RESPONSE_FIXTURE,
          output: [
            {
              type: "message",
              id: "msg_1",
              role: "assistant",
              content: [{ type: "refusal", refusal: "no" }],
            },
          ],
        }),
    ]),
  });
  const result = await provider.generate({
    model: "gpt-5.5",
    messages: [textMessage("user", "q")],
    output: { schema: { type: "object" } },
  });
  assert.equal(result.finishReason, "refusal");
  assert.deepEqual(result.message.content, [{ type: "text", text: "no" }]);
  assert.equal(result.output, undefined);
});

test("embeddings: request shape, ordering, usage", async () => {
  const captured: Captured[] = [];
  const provider = new OpenAIProvider({
    apiKey: "sk-test",
    fetch: mockFetch(
      [
        () =>
          jsonResponse({
            object: "list",
            model: "text-embedding-3-small",
            data: [
              { object: "embedding", index: 1, embedding: [0.3, 0.4] },
              { object: "embedding", index: 0, embedding: [0.1, 0.2] },
            ],
            usage: { prompt_tokens: 7, total_tokens: 7 },
          }),
      ],
      captured,
    ),
  });
  const result = await provider.embed({
    model: "text-embedding-3-small",
    input: ["a", "b"],
    providerOptions: { dimensions: 2 },
  });
  assert.equal(captured[0]!.url, "https://api.openai.com/v1/embeddings");
  assert.deepEqual(captured[0]!.body, {
    model: "text-embedding-3-small",
    input: ["a", "b"],
    dimensions: 2,
  });
  assert.deepEqual(result.embeddings, [
    [0.1, 0.2],
    [0.3, 0.4],
  ]);
  assert.equal(result.usage.input.total, 7);
});

test("web search: injects web_search tool with filters, context, and location", async () => {
  const captured: Captured[] = [];
  const provider = new OpenAIProvider({
    apiKey: "sk-test",
    fetch: mockFetch([() => jsonResponse(RESPONSE_FIXTURE)], captured),
  });
  await provider.generate({
    model: "gpt-5.5",
    messages: [textMessage("user", "q")],
    webSearch: {
      allowedDomains: ["example.com"],
      blockedDomains: ["spam.com"],
      contextSize: "high",
      userLocation: { country: "US", city: "SF" },
    },
  });
  assert.deepEqual(captured[0]!.body.tools, [
    {
      type: "web_search",
      filters: { allowed_domains: ["example.com"], blocked_domains: ["spam.com"] },
      search_context_size: "high",
      user_location: { type: "approximate", country: "US", city: "SF" },
    },
  ]);
});

test("web search: rejects unsupported models", async () => {
  const provider = new OpenAIProvider({
    apiKey: "sk-test",
    fetch: mockFetch([() => jsonResponse(RESPONSE_FIXTURE)]),
  });
  await assert.rejects(
    provider.generate({
      model: "o3",
      messages: [textMessage("user", "q")],
      webSearch: true,
    }),
    (error: unknown) =>
      error instanceof CardanError && error.code === "invalid_request",
  );
});

test("web search: extracts url_citation annotations", async () => {
  const provider = new OpenAIProvider({
    apiKey: "sk-test",
    fetch: mockFetch([
      () =>
        jsonResponse({
          ...RESPONSE_FIXTURE,
          output: [
            { type: "web_search_call", id: "ws_1", action: { type: "search" } },
            {
              type: "message",
              id: "msg_1",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "answer",
                  annotations: [
                    { type: "url_citation", url: "https://a.com", title: "A", start_index: 0, end_index: 6 },
                  ],
                },
              ],
            },
          ],
        }),
    ]),
  });
  const result = await provider.generate({
    model: "gpt-5.5",
    messages: [textMessage("user", "q")],
    webSearch: true,
  });
  assert.deepEqual(result.message.content, [{ type: "text", text: "answer" }]);
  assert.deepEqual(result.citations, [{ url: "https://a.com", title: "A" }]);
});

// ---------------------------------------------------------------------------
// Background mode
// ---------------------------------------------------------------------------

interface SeqCall {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

function mockFetchSeq(handlers: Array<() => Response>): {
  fetch: typeof globalThis.fetch;
  calls: SeqCall[];
} {
  const calls: SeqCall[] = [];
  let i = 0;
  const fetch = (async (input: unknown, init?: RequestInit) => {
    let body: Record<string, unknown> | undefined;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
      } catch {
        body = undefined;
      }
    }
    calls.push({ url: String(input), method: init?.method ?? "GET", body });
    const handler = handlers[Math.min(i, handlers.length - 1)]!;
    i++;
    return handler();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

function sse(...events: Array<Record<string, unknown>>): Response {
  return new Response(
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

test("background: high effort auto-enables background + store and polls", async () => {
  const { fetch, calls } = mockFetchSeq([
    () => jsonResponse({ id: "resp_bg", status: "queued" }),
    () => jsonResponse({ id: "resp_bg", status: "in_progress" }),
    () => jsonResponse({ ...RESPONSE_FIXTURE, id: "resp_bg" }),
  ]);
  const provider = new OpenAIProvider({ apiKey: "sk-test", fetch });
  const result = await provider.generate({
    model: "gpt-5.5",
    messages: [textMessage("user", "q")],
    reasoning: { effort: "high" },
  });
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.body!.background, true);
  assert.equal(calls[0]!.body!.store, true);
  assert.equal(calls[1]!.method, "GET");
  assert.equal(calls[1]!.url, "https://api.openai.com/v1/responses/resp_bg");
  assert.equal(calls[2]!.url, "https://api.openai.com/v1/responses/resp_bg");
  assert.deepEqual(result.message.content, [{ type: "text", text: "hi" }]);
});

test("background: low effort stays in the foreground (no background/store)", async () => {
  const { fetch, calls } = mockFetchSeq([() => jsonResponse(RESPONSE_FIXTURE)]);
  const provider = new OpenAIProvider({ apiKey: "sk-test", fetch });
  await provider.generate({
    model: "gpt-5.5",
    messages: [textMessage("user", "q")],
    reasoning: { effort: "low" },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.body!.background, undefined);
  assert.equal(calls[0]!.body!.store, false);
});

test("background: explicit false overrides high-effort auto", async () => {
  const { fetch, calls } = mockFetchSeq([() => jsonResponse(RESPONSE_FIXTURE)]);
  const provider = new OpenAIProvider({ apiKey: "sk-test", fetch });
  await provider.generate({
    model: "gpt-5.5",
    messages: [textMessage("user", "q")],
    reasoning: { effort: "max" },
    background: false,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.body!.background, undefined);
  assert.equal(calls[0]!.body!.store, false);
});

test("background: explicit true enables without reasoning", async () => {
  const { fetch, calls } = mockFetchSeq([() => jsonResponse(RESPONSE_FIXTURE)]);
  const provider = new OpenAIProvider({ apiKey: "sk-test", fetch });
  await provider.generate({
    model: "gpt-5.5",
    messages: [textMessage("user", "q")],
    background: true,
  });
  assert.equal(calls[0]!.body!.background, true);
  assert.equal(calls[0]!.body!.store, true);
});

test("background: stream resumes a dropped SSE via starting_after", async () => {
  const { fetch, calls } = mockFetchSeq([
    // POST opens the stream, then the connection drops after "he"
    () =>
      sse(
        { type: "response.created", sequence_number: 0, response: { id: "resp_s" } },
        { type: "response.output_text.delta", sequence_number: 1, delta: "he" },
      ),
    // GET resumes from the last sequence number and completes
    () =>
      sse(
        { type: "response.output_text.delta", sequence_number: 2, delta: "llo" },
        {
          type: "response.completed",
          sequence_number: 3,
          response: {
            status: "completed",
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      ),
  ]);
  const provider = new OpenAIProvider({ apiKey: "sk-test", fetch });
  const result = await collectStream(
    provider.stream({
      model: "gpt-5.5",
      messages: [textMessage("user", "q")],
      background: true,
    }),
  );
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.body!.background, true);
  assert.equal(calls[0]!.body!.stream, true);
  assert.equal(calls[1]!.method, "GET");
  assert.equal(
    calls[1]!.url,
    "https://api.openai.com/v1/responses/resp_s?stream=true&starting_after=1",
  );
  assert.deepEqual(result.message.content, [{ type: "text", text: "hello" }]);
  assert.equal(result.finishReason, "stop");
});

test("cache: forwards cache.key as prompt_cache_key (and omits when unset)", async () => {
  const captured: Captured[] = [];
  const provider = new OpenAIProvider({
    apiKey: "sk-test",
    fetch: mockFetch([() => jsonResponse(RESPONSE_FIXTURE)], captured),
  });
  await provider.generate({
    model: "gpt-5.5",
    messages: [textMessage("user", "q")],
    cache: { key: "conv-123" },
  });
  assert.equal(captured[0]!.body.prompt_cache_key, "conv-123");

  await provider.generate({
    model: "gpt-5.5",
    messages: [textMessage("user", "q")],
    cache: true,
  });
  assert.equal("prompt_cache_key" in captured[1]!.body, false);
});
