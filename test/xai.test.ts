import { test } from "node:test";
import assert from "node:assert/strict";

import { XAIProvider } from "../src/providers/xai.js";
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

const RESPONSE_FIXTURE = {
  id: "resp_1",
  object: "response",
  status: "completed",
  model: "grok-4.5",
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
    input_tokens: 50,
    input_tokens_details: { cached_tokens: 20 },
    output_tokens: 10,
    output_tokens_details: { reasoning_tokens: 3 },
  },
};

test("targets api.x.ai with stateless Responses defaults", async () => {
  const captured: Captured[] = [];
  const provider = new XAIProvider({
    apiKey: "xai-test",
    fetch: mockFetch([() => jsonResponse(RESPONSE_FIXTURE)], captured),
  });
  const result = await provider.generate({
    model: "grok-4.5",
    messages: [textMessage("user", "q")],
  });
  const request = captured[0]!;
  assert.equal(request.url, "https://api.x.ai/v1/responses");
  assert.equal(request.headers.authorization, "Bearer xai-test");
  assert.equal(request.body.store, false);
  assert.deepEqual(request.body.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(result.message.content, [{ type: "text", text: "hi" }]);
  assert.equal(result.usage.input.total, 50);
  assert.deepEqual(result.usage.input.details, { cache_read: 20 });
  // xAI reports reasoning_tokens on top of output_tokens: total output = 10 + 3.
  assert.equal(result.usage.output.total, 13);
  assert.deepEqual(result.usage.output.details, { reasoning: 3 });
});

test("folds reasoning_tokens into output.total (xAI additive accounting)", async () => {
  // Numbers from xAI's REST reference Responses example:
  // input 32 + output 9 + reasoning 110 = total 151.
  const provider = new XAIProvider({
    apiKey: "xai-test",
    fetch: mockFetch([
      () =>
        jsonResponse({
          ...RESPONSE_FIXTURE,
          usage: {
            input_tokens: 32,
            output_tokens: 9,
            output_tokens_details: { reasoning_tokens: 110 },
          },
        }),
    ]),
  });
  const result = await provider.generate({
    model: "grok-4.5",
    messages: [textMessage("user", "q")],
  });
  assert.equal(result.usage.input.total, 32);
  assert.equal(result.usage.output.total, 119); // 9 + 110
  assert.deepEqual(result.usage.output.details, { reasoning: 110 });
});

test("streaming finish folds reasoning_tokens into output.total", async () => {
  const sse = [
    'data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n',
    'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"yo"}\n\n',
    'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"yo"}]}],"usage":{"input_tokens":32,"output_tokens":9,"output_tokens_details":{"reasoning_tokens":110}}}}\n\n',
  ].join("");
  const provider = new XAIProvider({
    apiKey: "xai-test",
    fetch: mockFetch([() => new Response(sse, { status: 200 })]),
  });
  const result = await collectStream(
    provider.stream({ model: "grok-4.5", messages: [textMessage("user", "q")] }),
  );
  assert.equal(result.usage.output.total, 119); // 9 + 110
  assert.deepEqual(result.usage.output.details, { reasoning: 110 });
});

test("keeps sampling params on reasoning models", async () => {
  const captured: Captured[] = [];
  const provider = new XAIProvider({
    apiKey: "xai-test",
    fetch: mockFetch([() => jsonResponse(RESPONSE_FIXTURE)], captured),
  });
  await provider.generate({
    model: "grok-4.5",
    messages: [textMessage("user", "q")],
    temperature: 0.5,
    topP: 0.9,
  });
  assert.equal(captured[0]!.body.temperature, 0.5);
  assert.equal(captured[0]!.body.top_p, 0.9);
});

test("maps reasoning effort to the xAI range, without summary", async () => {
  const captured: Captured[] = [];
  const provider = new XAIProvider({
    apiKey: "xai-test",
    fetch: mockFetch([() => jsonResponse(RESPONSE_FIXTURE)], captured),
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
  await generate("grok-4.5", { effort: "max" });
  await generate("grok-4.5", { enabled: false });
  await generate("grok-4.5", { enabled: true });
  // pre-4.5 fast SKUs reject graded effort — omit entirely
  await generate("grok-4-fast-reasoning", { effort: "medium" });
  await generate("grok-code-fast-1", { effort: "max" });
  assert.deepEqual(captured[0]!.body.reasoning, { effort: "high" });
  // xAI rejects `effort: none`, so reasoning cannot be disabled: field omitted.
  assert.equal(captured[1]!.body.reasoning, undefined);
  // no effort requested → provider default; field omitted entirely
  assert.equal(captured[2]!.body.reasoning, undefined);
  assert.equal(captured[3]!.body.reasoning, undefined);
  assert.equal(captured[4]!.body.reasoning, undefined);
});

test("streams via the shared Responses parser", async () => {
  const sse = [
    'data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n',
    'data: {"type":"response.reasoning_summary_text.delta","item_id":"rs_1","delta":"hm"}\n\n',
    'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"hm"}],"encrypted_content":"enc_1"}}\n\n',
    'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"yo"}\n\n',
    'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"yo"}]}],"usage":{"input_tokens":5,"output_tokens":2}}}\n\n',
  ].join("");
  const provider = new XAIProvider({
    apiKey: "xai-test",
    fetch: mockFetch([() => new Response(sse, { status: 200 })]),
  });
  const result = await collectStream(
    provider.stream({ model: "grok-4.5", messages: [textMessage("user", "q")] }),
  );
  assert.deepEqual(result.message.content, [
    { type: "thinking", text: "hm", signature: "enc_1", id: "rs_1" },
    { type: "text", text: "yo" },
  ]);
  assert.equal(result.finishReason, "stop");
  assert.equal(result.usage.input.total, 5);
});

test("embed reports invalid_request (xAI has no embeddings API)", async () => {
  const provider = new XAIProvider({ apiKey: "xai-test" });
  await assert.rejects(
    provider.embed({ model: "grok-4.5", input: ["a"] }),
    (error: unknown) =>
      error instanceof CardanError &&
      error.code === "invalid_request" &&
      error.provider === "xai",
  );
});

test("Cardan routes xai/ model ids to the xAI provider", async () => {
  const captured: Captured[] = [];
  const cardan = createCardan({
    xai: {
      apiKey: "xai-test",
      fetch: mockFetch([() => jsonResponse(RESPONSE_FIXTURE)], captured),
    },
  });
  await cardan.generate({
    model: "xai/grok-4.5",
    messages: [textMessage("user", "q")],
  });
  assert.equal(captured[0]!.url, "https://api.x.ai/v1/responses");
  assert.equal(captured[0]!.body.model, "grok-4.5");
});

test("web search: uses xAI filters shape, allowed capped at five", async () => {
  const captured: Captured[] = [];
  const provider = new XAIProvider({
    apiKey: "xai-test",
    fetch: mockFetch([() => jsonResponse(RESPONSE_FIXTURE)], captured),
  });
  await provider.generate({
    model: "grok-4.5",
    messages: [textMessage("user", "q")],
    webSearch: {
      allowedDomains: ["a.com", "b.com", "c.com", "d.com", "e.com", "f.com"],
      contextSize: "high", // ignored by xAI
    },
  });
  assert.deepEqual(captured[0]!.body.tools, [
    {
      type: "web_search",
      filters: { allowed_domains: ["a.com", "b.com", "c.com", "d.com", "e.com"] },
    },
  ]);
});

test("web search: blocked domains map to excluded_domains", async () => {
  const captured: Captured[] = [];
  const provider = new XAIProvider({
    apiKey: "xai-test",
    fetch: mockFetch([() => jsonResponse(RESPONSE_FIXTURE)], captured),
  });
  await provider.generate({
    model: "grok-4.5",
    messages: [textMessage("user", "q")],
    webSearch: { blockedDomains: ["spam.com"] },
  });
  assert.deepEqual(captured[0]!.body.tools, [
    { type: "web_search", filters: { excluded_domains: ["spam.com"] } },
  ]);
});

test("web search: rejects non-grok-4 models", async () => {
  const provider = new XAIProvider({
    apiKey: "xai-test",
    fetch: mockFetch([() => jsonResponse(RESPONSE_FIXTURE)]),
  });
  await assert.rejects(
    provider.generate({
      model: "grok-3",
      messages: [textMessage("user", "q")],
      webSearch: true,
    }),
    (error: unknown) =>
      error instanceof CardanError && error.code === "invalid_request",
  );
});

test("web search: reads both annotations and top-level citations", async () => {
  const provider = new XAIProvider({
    apiKey: "xai-test",
    fetch: mockFetch([
      () =>
        jsonResponse({
          ...RESPONSE_FIXTURE,
          output: [
            {
              type: "message",
              id: "msg_1",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "answer",
                  annotations: [{ type: "url_citation", url: "https://a.com", title: "A" }],
                },
              ],
            },
          ],
          citations: ["https://b.com", { url: "https://c.com", title: "C" }],
        }),
    ]),
  });
  const result = await provider.generate({
    model: "grok-4.5",
    messages: [textMessage("user", "q")],
    webSearch: true,
  });
  assert.deepEqual(result.citations, [
    { url: "https://a.com", title: "A" },
    { url: "https://b.com" },
    { url: "https://c.com", title: "C" },
  ]);
});

test("background: never sent (xAI rejects it), even at high effort", async () => {
  const captured: Captured[] = [];
  const provider = new XAIProvider({
    apiKey: "xai-test",
    fetch: mockFetch([() => jsonResponse(RESPONSE_FIXTURE)], captured),
  });
  // OpenAI auto-enables background for high/xhigh/max effort; xAI must not —
  // its Responses API 400s on `background`. A single POST completes inline.
  await provider.generate({
    model: "grok-4.5",
    messages: [textMessage("user", "q")],
    reasoning: { effort: "high" },
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.url, "https://api.x.ai/v1/responses");
  assert.equal(captured[0]!.body.background, undefined);
  assert.equal(captured[0]!.body.store, false);
  assert.deepEqual(captured[0]!.body.reasoning, { effort: "high" });
});
