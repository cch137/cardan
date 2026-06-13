# cardan

Unified TypeScript adapter for major LLM provider APIs. Zero runtime dependencies — adapters speak HTTP via native `fetch`. Runs on Node ≥ 20, Deno, and edge runtimes.

See [DESIGN.md](./DESIGN.md) for goals, non-goals, and provider tiers.

## Status

0.x — API is unstable until raven/ticks migrate onto it. Implemented: core schema + Anthropic, OpenAI (Responses API), Gemini, xAI, Groq, and Modal (self-deployed, Chat Completions) adapters (generate, streaming, tools, structured output, thinking, vision; OpenAI, Gemini, and Modal also embeddings).

## Usage

```ts
import { createCardan } from "cardan";

const cardan = createCardan(); // reads ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / XAI_API_KEY / GROQ_API_KEY from env

// generate
const result = await cardan.generate({
  model: "anthropic/claude-opus-4-8",
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
});
console.log(result.message, result.usage, result.finishReason);

// streaming
for await (const event of cardan.stream({ model: "anthropic/claude-opus-4-8", messages })) {
  if (event.type === "text_delta") process.stdout.write(event.text);
}

// tools (parameters accept plain JSON Schema or a zod 4 schema)
await cardan.generate({
  model: "anthropic/claude-opus-4-8",
  messages,
  tools: [{ name: "get_weather", description: "…", parameters: { type: "object", properties: { city: { type: "string" } } } }],
});

// structured output — zod schemas are converted and the result validated via .parse()
const extracted = await cardan.generate({
  model: "anthropic/claude-opus-4-8",
  messages,
  output: { schema: z.object({ name: z.string() }) },
});
console.log(extracted.output);
```

Per-provider use without the `provider/` prefix:

```ts
import { AnthropicProvider } from "cardan";
const anthropic = new AnthropicProvider({ apiKey: "sk-…" });
await anthropic.generate({ model: "claude-opus-4-8", messages });
```

`collectStream(stream)` accumulates a stream into a `GenerateResult`-shaped value (message + finishReason + usage); `collectStreamToMessage(stream)` returns just the assistant `Message`, ready to push back into the next request. See [Reasoning / thinking state](#reasoning--thinking-state).

## Behavior notes

- **Message normalization** (applied before every request): consecutive same-role messages merge; `tool_result` parts are relocated into a `tool` message directly after their `tool_call`, in call order; a dangling `tool_call` (no result) gets a synthesized error result (`isError: true`) so aborted conversations stay replayable; an orphan or duplicate `tool_result` throws `invalid_request`.
- **System messages**: leading system messages hoist to the provider's top-level system field (Anthropic `system`, Gemini `systemInstruction`); mid-conversation system messages downgrade to user text. OpenAI's Responses API accepts `system` anywhere in `input`, so system messages pass through in place.
- **OpenAI is stateless by default**: every request sends `store: false` + `include: ["reasoning.encrypted_content"]`; context is replayed from `messages` and reasoning items survive multi-turn tool use via `encrypted_content` (held in `ThinkingPart.signature` with the item id in `ThinkingPart.id`). Override via `providerOptions`. The Responses API has no stop-sequence parameter, so `stopSequences` is ignored there.
- **xAI** speaks the same Responses API (its Chat Completions endpoint is documented as legacy), so the adapter subclasses the OpenAI one and inherits the stateless defaults above. Differences: `reasoning.effort` caps at `high` (grok-4.3+ only — omit `reasoning` for older models), no `summary` parameter is sent (xAI always returns detailed reasoning summaries), grok models keep `temperature`/`top_p`, and there is no embeddings API.
- **Groq** speaks the **Chat Completions** API (`/openai/v1/chat/completions`) — Groq's Responses API is beta and rejects the `store`/`include` parameters the stateless OpenAI adapter depends on. Reasoning models (gpt-oss, qwen3) always get `reasoning_format: "parsed"`, so thinking arrives in `message.reasoning` → thinking parts (no signature; never replayed). `reasoning.effort` → `reasoning_effort`: gpt-oss grades `low`/`medium`/`high` (`xhigh`/`max` cap to `high`), qwen3 only accepts `none`/`default` so graded efforts are omitted; `enabled: false` → `"none"` (qwen3 only — gpt-oss cannot disable reasoning). Omit `reasoning` for non-reasoning models. Structured output sends `strict: true` (constrained decoding) on gpt-oss and best-effort mode elsewhere; models without `json_schema` support (llama-3.x) reject it. Prompt caching is automatic (`cache_read` in usage details); oversized prompts (413) map to `context_length`; no embeddings API.
- **Modal** is for self-deployed models behind Modal web endpoints (vLLM/SGLang), which speak the **Chat Completions** API. `baseUrl` is required (per-deployment `*.modal.run` URL; or `MODAL_BASE_URL`). Auth is optional and dual-track: `apiKey` → `Authorization: Bearer` (vLLM/SGLang `--api-key`; `MODAL_API_KEY`) and/or `proxyAuth` → `Modal-Key`/`Modal-Secret` headers (Modal Proxy Auth Tokens; `MODAL_KEY`/`MODAL_SECRET`). Responses' `reasoning_content` maps to thinking parts; thinking is never replayed (Chat Completions has no replay format). `reasoning.effort` → `reasoning_effort` (caps at `high`; unsupported servers reject it — omit `reasoning` then), `reasoning.enabled` is ignored (use `providerOptions`, e.g. vLLM `chat_template_kwargs`). Sends `max_tokens` for compatibility; `embed` hits `/v1/embeddings` if the deployment serves an embedding model.
- **Usage**: `input.total` includes cached tokens; breakdown in `details` (`cache_read`, `cache_write`, `reasoning`).
- **Retry**: 429/529/5xx/network errors retry with exponential backoff (default 2 retries), honoring `Retry-After` (and Gemini's `RetryInfo.retryDelay`). Disable with `retry: false`. Streams only retry before the first byte.
- **Capability table**: models that reject sampling params (Fable 5 / Mythos 5 / Opus 4.7+, OpenAI o-series / non-chat gpt-5*) have `temperature`/`topP` dropped silently; Gemini 3 maps `reasoning.effort` to `thinkingLevel`, Gemini 2.x to `thinkingBudget`.
- **`reasoning`**: `{ enabled: true }` → Anthropic adaptive thinking / Gemini `includeThoughts` / OpenAI `reasoning.summary: "auto"`; `effort` → Anthropic `output_config.effort` / Gemini thinking level or budget / OpenAI `reasoning.effort` (`max` caps to `xhigh`; `enabled: false` → `effort: "none"`, gpt-5.1+ only). Use `providerOptions` for anything provider-specific (e.g. beta headers go in provider `headers`).
- **Thinking parts**: replayed with their `signature`; unsigned thinking parts are dropped on send; `redacted: true` maps to Anthropic `redacted_thinking`.
- **Tool call ids**: provider-assigned ids are preserved verbatim. Gemini 2.x omits function-call ids, so the adapter synthesizes `cardan_call_…` ids for pairing and strips them on replay; Gemini `thoughtSignature`s ride on `signature` of text/thinking/tool_call parts and are required for Gemini 3 function-calling replay (preserved identically in streaming and non-streaming — see below).
- **Gemini files**: image/file input supports inline bytes (`inlineData`) and `URL` → `fileData.fileUri` passthrough (Files API URIs); cardan does not wrap the File API itself. `embed` uses `batchEmbedContents`, which returns no usage metadata.
- **Errors**: all failures are `CardanError` with `code` (`auth` / `rate_limit` / `overloaded` / `context_length` / `invalid_request` / `not_found` / `server` / `network` / `aborted` / `unknown`), `status`, `retryable`, and the raw provider body in `raw`.

## Reasoning / thinking state

Providers return opaque reasoning state that must be replayed verbatim for multi-turn / tool-use loops to keep working. cardan normalizes it onto `ThinkingPart`/`TextPart`/`ToolCallPart` and replays it to the **same** provider:

- **Anthropic** — `thinking` blocks carry `signature`; `redacted_thinking` carries opaque `data` (mapped to `signature` with `redacted: true`). Both are replayed unchanged and in order; unsigned thinking is dropped on send.
- **OpenAI / xAI** — stateless by default (`store: false` + `include: ["reasoning.encrypted_content"]`). The encrypted reasoning item is held in `ThinkingPart.signature` with its item id in `ThinkingPart.id`; both are required to replay, so summary-only thinking (no `encrypted_content`) is dropped. For server-side state instead, pass `previous_response_id` via `providerOptions`.
- **Gemini** — every `Part` (text, thought, or `functionCall`) may carry a `thoughtSignature`; it rides on `signature` and is sent back on the original Part. Signed Parts are never merged with each other or with unsigned Parts. Function-call `id`s are preserved and echoed in the matching `functionResponse`.

**Streaming and non-streaming preserve the same replay-critical state.** Signatures, encrypted reasoning content, ids, and tool-call signatures all survive collection identically.

Use **`collectStream(stream)`** / **`collectStreamToMessage(stream)`** to capture a streamed turn — they reassemble the parts (including signatures) correctly. If you consume stream events yourself, you must retain the `signature` field on `text_delta`/`thinking_delta` deltas, `thinking_signature` events, and `tool_call` event signatures; dropping them loses reasoning state and breaks the next turn. Push the collected `Message` back into `messages` as-is — don't reduce a tool-use turn to its text.

Opaque state is provider-specific: replay a reasoning-bearing turn to the **same** provider that produced it. cardan does not strip foreign signatures, so feeding one provider's thinking/reasoning parts to another will send invalid opaque state — start a fresh turn (or drop the thinking parts) when switching providers mid-conversation.

## Development

```sh
npm install
npm run typecheck
npm test        # fixture unit tests (no network)
npm run build
```
