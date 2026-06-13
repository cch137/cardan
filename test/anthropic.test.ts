import { test } from "node:test";
import assert from "node:assert/strict";

import { AnthropicProvider } from "../src/providers/anthropic.js";
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
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-4-8",
  content: [{ type: "text", text: "hi" }],
  stop_reason: "end_turn",
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 90,
    cache_creation_input_tokens: 20,
  },
};

test("builds request: system hoist, tool results, defaults, headers", async () => {
  const captured: Captured[] = [];
  const provider = new AnthropicProvider({
    apiKey: "sk-test",
    fetch: mockFetch([() => jsonResponse(RESPONSE_FIXTURE)], captured),
  });

  const messages: Message[] = [
    textMessage("system", "be terse"),
    textMessage("user", "q"),
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "c1", name: "f", args: { x: 1 } }],
    },
    {
      role: "tool",
      content: [{ type: "tool_result", callId: "c1", result: { ok: true } }],
    },
    textMessage("system", "mid-conversation note"),
    textMessage("user", "next"),
  ];

  await provider.generate({
    model: "claude-sonnet-4-6",
    messages,
    temperature: 0.5,
    tools: [{ name: "f", description: "d", parameters: { type: "object" } }],
    toolChoice: "required",
  });

  const request = captured[0]!;
  assert.equal(request.url, "https://api.anthropic.com/v1/messages");
  assert.equal(request.headers["x-api-key"], "sk-test");
  assert.equal(request.headers["anthropic-version"], "2023-06-01");

  const body = request.body;
  assert.equal(body.system, "be terse");
  assert.equal(body.max_tokens, 16000);
  assert.equal(body.temperature, 0.5);
  assert.deepEqual(body.tool_choice, { type: "any" });
  assert.deepEqual(body.tools, [
    { name: "f", description: "d", input_schema: { type: "object" } },
  ]);

  const sent = body.messages as Array<{ role: string; content: unknown[] }>;
  assert.deepEqual(
    sent.map((m) => m.role),
    ["user", "assistant", "user", "user"],
  );
  assert.deepEqual(sent[1]!.content, [
    { type: "tool_use", id: "c1", name: "f", input: { x: 1 } },
  ]);
  assert.deepEqual(sent[2]!.content, [
    { type: "tool_result", tool_use_id: "c1", content: '{"ok":true}' },
  ]);
  // mid-conversation system downgraded to user text, merged with next user turn
  assert.deepEqual(sent[3]!.content, [
    { type: "text", text: "mid-conversation note" },
    { type: "text", text: "next" },
  ]);
});

test("drops sampling params on models that reject them", async () => {
  const captured: Captured[] = [];
  const provider = new AnthropicProvider({
    apiKey: "sk-test",
    fetch: mockFetch([() => jsonResponse(RESPONSE_FIXTURE)], captured),
  });
  await provider.generate({
    model: "claude-opus-4-8",
    messages: [textMessage("user", "q")],
    temperature: 0.5,
    topP: 0.9,
    reasoning: { enabled: true, effort: "high" },
  });
  const body = captured[0]!.body;
  assert.equal(body.temperature, undefined);
  assert.equal(body.top_p, undefined);
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.deepEqual(body.output_config, { effort: "high" });
});

test("reasoning: effort alone enables thinking; enabled:false disables", async () => {
  const captured: Captured[] = [];
  const provider = new AnthropicProvider({
    apiKey: "sk-test",
    fetch: mockFetch([() => jsonResponse(RESPONSE_FIXTURE)], captured),
  });
  // effort without `enabled` implies enabled
  await provider.generate({
    model: "claude-opus-4-8",
    messages: [textMessage("user", "q")],
    reasoning: { effort: "high" },
  });
  assert.deepEqual(captured[0]!.body.thinking, { type: "adaptive" });
  assert.deepEqual(captured[0]!.body.output_config, { effort: "high" });
  // enabled:false sends neither thinking nor an effort hint
  await provider.generate({
    model: "claude-opus-4-8",
    messages: [textMessage("user", "q")],
    reasoning: { enabled: false, effort: "high" },
  });
  assert.equal(captured[1]!.body.thinking, undefined);
  assert.equal(captured[1]!.body.output_config, undefined);
});

test("parses response: parts, finish reason, usage totals", async () => {
  const provider = new AnthropicProvider({
    apiKey: "sk-test",
    fetch: mockFetch([() => jsonResponse(RESPONSE_FIXTURE)]),
  });
  const result = await provider.generate({
    model: "claude-opus-4-8",
    messages: [textMessage("user", "q")],
  });
  assert.deepEqual(result.message, {
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
  });
  assert.equal(result.finishReason, "stop");
  assert.equal(result.usage.input.total, 120);
  assert.deepEqual(result.usage.input.details, { cache_read: 90, cache_write: 20 });
  assert.equal(result.usage.output.total, 5);
});

test("usage: thinking-token breakdown maps to output.details.reasoning without double-counting", async () => {
  const provider = new AnthropicProvider({
    apiKey: "sk-test",
    fetch: mockFetch([
      () =>
        jsonResponse({
          ...RESPONSE_FIXTURE,
          usage: {
            input_tokens: 10,
            output_tokens: 30,
            output_tokens_details: { thinking_tokens: 12 },
          },
        }),
    ]),
  });
  const result = await provider.generate({
    model: "claude-opus-4-8",
    messages: [textMessage("user", "q")],
  });
  // total stays output_tokens; reasoning is only a breakdown, not re-added
  assert.equal(result.usage.output.total, 30);
  assert.deepEqual(result.usage.output.details, { reasoning: 12 });
});

test("usage: no thinking breakdown means no fabricated reasoning detail", async () => {
  const provider = new AnthropicProvider({
    apiKey: "sk-test",
    fetch: mockFetch([() => jsonResponse(RESPONSE_FIXTURE)]),
  });
  const result = await provider.generate({
    model: "claude-opus-4-8",
    messages: [textMessage("user", "q")],
  });
  assert.deepEqual(result.usage.output.details, {});
});

test("maps HTTP errors and respects Retry-After on retry", async () => {
  const captured: Captured[] = [];
  const provider = new AnthropicProvider({
    apiKey: "sk-test",
    fetch: mockFetch(
      [
        () =>
          jsonResponse(
            { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
            429,
            { "retry-after": "0" },
          ),
        () => jsonResponse(RESPONSE_FIXTURE),
      ],
      captured,
    ),
  });
  const result = await provider.generate({
    model: "claude-opus-4-8",
    messages: [textMessage("user", "q")],
    retry: { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 5 },
  });
  assert.equal(captured.length, 2);
  assert.equal(result.finishReason, "stop");
});

test("non-retryable errors carry code and raw body", async () => {
  const provider = new AnthropicProvider({
    apiKey: "sk-test",
    fetch: mockFetch([
      () =>
        jsonResponse(
          { type: "error", error: { type: "invalid_request_error", message: "prompt is too long" } },
          400,
        ),
    ]),
  });
  await assert.rejects(
    provider.generate({ model: "claude-opus-4-8", messages: [textMessage("user", "q")] }),
    (error: unknown) =>
      error instanceof CardanError &&
      error.code === "context_length" &&
      error.status === 400,
  );
});

const STREAM_FIXTURE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-opus-4-8","stop_reason":null,"usage":{"input_tokens":25,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig1"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"He"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"llo"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather","input":{}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"location\\":"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":" \\"SF\\"}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":89}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

test("streams: deltas, signatures, tool calls, finish usage", async () => {
  const provider = new AnthropicProvider({
    apiKey: "sk-test",
    fetch: mockFetch([
      () => new Response(STREAM_FIXTURE, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ]),
  });
  const result = await collectStream(
    provider.stream({ model: "claude-opus-4-8", messages: [textMessage("user", "q")] }),
  );
  assert.deepEqual(result.message.content, [
    { type: "thinking", text: "hmm", signature: "sig1" },
    { type: "text", text: "Hello" },
    { type: "tool_call", id: "toolu_1", name: "get_weather", args: { location: "SF" } },
  ]);
  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.usage.input.total, 25);
  assert.equal(result.usage.output.total, 89);
});

test("stream error events raise CardanError", async () => {
  const sse =
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n' +
    'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';
  const provider = new AnthropicProvider({
    apiKey: "sk-test",
    fetch: mockFetch([() => new Response(sse, { status: 200 })]),
  });
  await assert.rejects(
    collectStream(
      provider.stream({ model: "claude-opus-4-8", messages: [textMessage("user", "q")] }),
    ),
    (error: unknown) => error instanceof CardanError && error.code === "overloaded",
  );
});

test("structured output parses and surfaces JSON", async () => {
  const provider = new AnthropicProvider({
    apiKey: "sk-test",
    fetch: mockFetch([
      () =>
        jsonResponse({
          ...RESPONSE_FIXTURE,
          content: [{ type: "text", text: '{"name":"Jane"}' }],
        }),
    ]),
  });
  const result = await provider.generate({
    model: "claude-opus-4-8",
    messages: [textMessage("user", "extract")],
    output: { schema: { type: "object", properties: { name: { type: "string" } } } },
  });
  assert.deepEqual(result.output, { name: "Jane" });
});
