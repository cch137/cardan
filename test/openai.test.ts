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
  model: "gpt-5.2",
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
    model: "gpt-5.2",
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

test("drops sampling params on reasoning models, keeps them on gpt-4.1", async () => {
  const captured: Captured[] = [];
  const provider = new OpenAIProvider({
    apiKey: "sk-test",
    fetch: mockFetch([() => jsonResponse(RESPONSE_FIXTURE)], captured),
  });
  await provider.generate({
    model: "gpt-5.2",
    messages: [textMessage("user", "q")],
    temperature: 0.5,
    topP: 0.9,
    reasoning: { enabled: true, effort: "max" },
  });
  await provider.generate({
    model: "gpt-4.1",
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
    model: "gpt-5.2",
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
    model: "gpt-5.2",
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
    model: "gpt-5.2",
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
    model: "gpt-5.2",
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
    failing.generate({ model: "gpt-5.2", messages: [textMessage("user", "q")] }),
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
    provider.stream({ model: "gpt-5.2", messages: [textMessage("user", "q")] }),
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
      provider.stream({ model: "gpt-5.2", messages: [textMessage("user", "q")] }),
    ),
    (error: unknown) => error instanceof CardanError && error.code === "server",
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
    model: "gpt-5.2",
    messages: [textMessage("user", "extract")],
    output: { schema },
  });
  assert.deepEqual(captured[0]!.body.text, {
    format: { type: "json_schema", name: "output", strict: true, schema },
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
    model: "gpt-5.2",
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
