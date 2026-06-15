# cardan

Unified TypeScript adapter for major LLM provider APIs. Zero runtime dependencies — adapters speak HTTP via native `fetch`. Runs on Node ≥ 20, Deno, and edge runtimes.

See [DESIGN.md](./DESIGN.md) for goals, non-goals, and provider tiers.

## Status

0.x — API is unstable until raven/ticks migrate onto it. Implemented: core schema + Anthropic, OpenAI (Responses API), Google (Gemini API), xAI, Groq, and Modal (self-deployed, Chat Completions) adapters (generate, streaming, tools, structured output, thinking, vision; OpenAI, Google, and Modal also embeddings).

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

// built-in web search — the provider runs the searches server-side and the
// answer comes back with citations. `true` for defaults, or an options object.
const searched = await cardan.generate({
  model: "anthropic/claude-opus-4-8",
  messages,
  webSearch: { maxUses: 5, allowedDomains: ["arxiv.org"] },
});
console.log(searched.message, searched.citations); // [{ url, title?, snippet? }, …]
```

Per-provider use without the `provider/` prefix:

```ts
import { AnthropicProvider } from "cardan";
const anthropic = new AnthropicProvider({ apiKey: "sk-…" });
await anthropic.generate({ model: "claude-opus-4-8", messages });
```

`collectStream(stream)` accumulates a stream into a `GenerateResult`-shaped value (message + finishReason + usage); `collectStreamToMessage(stream)` returns just the assistant `Message`, ready to push back into the next request. See [Reasoning / thinking state](#reasoning--thinking-state).

### Conversation

`cardan.conversation(options)` returns a stateful `Conversation` that holds a running transcript and collapses the "push user → generate → push assistant" dance into one `ask`. Every generation option (`model`, `reasoning`, `tools`, …) is a default carried on `defaults`, overridable per turn and reassignable mid-conversation — `model` is not privileged.

```ts
import { defineTool, type Infer } from "cardan";
import { z } from "zod";

const c = cardan.conversation({
  model: "anthropic/claude-opus-4-8",
  system: "You are a research assistant.",
  reasoning: { effort: "high" }, // a default for every turn
  label: "research",             // tag for onCall telemetry
  onCall: (i) => console.log(`${i.tag} ${i.model} ${i.ms}ms ${i.usage.output.total}tok ${i.finishReason ?? i.error}`),
});

// Tools: defineTool infers the handler args from the schema (no casts).
const search = defineTool(
  { name: "web_search", description: "Search the web.", parameters: z.object({ query: z.string() }) },
  ({ query }) => runSearch(query), // query: string
);

// With tools, ask loops model↔tools until it stops. `compact` then rewrites the
// round-trips so their bulky raw outputs aren't replayed on later turns — the
// default keeps the tool-use trace but blanks the result bodies.
await c.ask("Research the topic and conclude.", { tools: [search], compact: true, step: "research" });

// Structured output is just an option on ask: pass `output.schema` and read the
// parsed (zod-validated) value off the result — type it yourself if you want.
const res = await c.ask("Emit the final report as JSON.", { output: { schema: reportSchema } });
const report = res.output as Infer<typeof reportSchema>;

c.defaults.model = "openai/gpt-5.4"; // switch model for all later turns
```

`ask` adds a user turn, generates, appends the reply, and returns the `GenerateResult`; with `tools` it loops (`maxRounds` caps the loop, forcing a tool-free conclusion on the last round). Structured output stays a plain option (`output.schema`) — `res.output` holds the parsed value; cast it with the exported `Infer<typeof schema>` helper if you want the static type. `output` and `tools` can't be combined in one `ask` (structured output is constrained decoding, which blocks tool calls, so `ask` throws) — run the tool loop first, then ask again with `output`, as the examples do. cardan logs nothing itself: pass `onCall` to receive per-call telemetry (`tag`, `model`, `ms`, `usage`, `citations`, `finishReason` on success / `error` on failure) and format it however you like.

`compact` keeps a tool-using turn from bloating later context. The default compactor (`redactToolResults`) keeps the tool-call/result structure — so the model still sees it reached the conclusion *by using tools* and won't mistake it for innate knowledge — but replaces each result's payload with a short placeholder (this also keeps raw page content from tripping provider filters on replay). Pass your own `Compactor` (`(region: Message[]) => Message[]`) to customize, e.g. the built-in `dropToolRounds` (keep only the conclusion) or an LLM-written summary.

`fork(overrides?)` branches a conversation: the copy shares the client/defaults but gets an independent transcript, so diverging turns never touch the original — use it before fanning work out in parallel (a shared mutable transcript would corrupt).

### Flow

`createFlow<State>()(config?)` is a tiny runner for multi-step work over a shared typed state. There is no graph to declare — a **step** is just an async function, and it decides what runs next by returning `goto(nextStep, patch?)`. Branching, loops, and fan-out live in ordinary code (`if`, recursion, an array of steps); a step that returns without a `goto` ends its branch. No edge table, no `END` sentinel.

A full pipeline — screen → investigate → report — showing a self-loop, intra-step parallelism, structured output, and ending by returning without a `goto`:

```ts
import { createFlow, goto, parallel, withConversations } from "cardan";
import type { ConversationContext, FlowEvent, Step } from "cardan";
import { z } from "zod";

type State = {
  candidates: Event[];
  picked: string[];
  reports: Record<string, Report>;
  attempt: number;
};

const flow = createFlow<State>()({
  maxSteps: 25,                                       // cap supersteps (loop guard)
  reducers: { reports: (a, b) => ({ ...a, ...b }) },  // merge concurrent writes to `reports`
  extendCtx: withConversations(cardan),               // every step gets ctx.conversation(...)
});

// 1) Screen candidates. If none are picked, loop back to retry (bounded by `attempt`).
const screen: Step<State, ConversationContext> = async (s, ctx) => {
  const c = ctx.conversation({ model: "anthropic/claude-opus-4-8", label: "screen" });
  const res = await c.ask(`Pick the noteworthy events:\n${format(s.candidates)}`, {
    output: { schema: z.object({ ids: z.array(z.string()) }) },
  });
  const picked = (res.output as { ids: string[] }).ids;
  if (picked.length === 0 && s.attempt < 2) {
    return goto(screen, { attempt: s.attempt + 1 });  // self-loop = retry
  }
  return goto(investigate, { picked });               // route on to the next step
};

// 2) Investigate each picked item concurrently — fan out *inside* one step with
//    parallel(). Each item gets its own conversation, so transcripts don't collide;
//    every ctx.conversation call surfaces as an `llm` flow event tagged "inv <id>".
const investigate: Step<State, ConversationContext> = async (s, ctx) => {
  const entries = await parallel(s.picked, async (id, _i, signal) => {
    const c = ctx.conversation({ model: "anthropic/claude-opus-4-8", label: `inv ${id}` });
    await c.ask(`Research ${id}.`, { tools: [search], compact: true, signal });
    const res = await c.ask("Emit the report.", { output: { schema: reportSchema }, signal });
    return [id, res.output as Report] as const;
  }, { concurrency: 4, signal: ctx.signal });           // ≤ 4 in flight; signal threads into each ask
  return goto(report, { reports: Object.fromEntries(entries) });
};

// 3) Publish and stop — returning without a goto ends the flow.
const report: Step<State> = async (s) => {
  await publish(s.reports);
};

const onEvent = (e: FlowEvent) => console.log(`${e.type} ${e.name ?? ""}`);
const final = await flow.run(screen, { candidates, picked: [], reports: {}, attempt: 0 }, { onEvent });
```

Routing lives in the step: return `goto(next, patch?)` to continue, `goto([a, b], patch?)` to fan out (those steps run in parallel next superstep), or a plain patch / nothing to stop. Loops are a step that `goto`s itself; conditional routing is an `if`/`switch` choosing the next step. Execution is by superstep — steps scheduled together run concurrently on the same state snapshot, their patches merge at the barrier (a reducer is required for any key two steps write at once, else it throws), then the next set runs. `maxSteps` caps the superstep count (the loop guard); `concurrency` caps in-flight tasks inside one `parallel()` call.

**Step-level fan-out** is for branches with *different* logic that converge on a join — steps that `goto` the same function run once on the merged state:

```ts
const plan:       Step<S> = () => goto([searchWeb, searchDocs]);          // fan out
const searchWeb:  Step<S> = async () => goto(synthesize, { web:  await web()  });
const searchDocs: Step<S> = async () => goto(synthesize, { docs: await docs() });
const synthesize: Step<S> = (s) => ({ answer: combine(s.web, s.docs) }); // joins, runs once
```

**Parallel, two ways**: do the same work over N items *inside* a step with `parallel()` (the common case — concurrency-limited, order-preserving); use step-level fan-out only when branches have *different downstream routing*. `onEvent` receives `step:start` / `step:end` / `error`, plus `llm` events for every call made through `ctx.conversation`.

## Behavior notes

- **Message normalization** (applied before every request): consecutive same-role messages merge; `tool_result` parts are relocated into a `tool` message directly after their `tool_call`, in call order; a dangling `tool_call` (no result) gets a synthesized error result (`isError: true`) so aborted conversations stay replayable; an orphan or duplicate `tool_result` throws `invalid_request`.
- **System messages**: leading system messages hoist to the provider's top-level system field (Anthropic `system`, Gemini `systemInstruction`); mid-conversation system messages downgrade to user text. OpenAI's Responses API accepts `system` anywhere in `input`, so system messages pass through in place.
- **OpenAI is stateless by default**: every request sends `store: false` + `include: ["reasoning.encrypted_content"]`; context is replayed from `messages` and reasoning items survive multi-turn tool use via `encrypted_content` (held in `ThinkingPart.signature` with the item id in `ThinkingPart.id`). Override via `providerOptions`. The Responses API has no stop-sequence parameter, so `stopSequences` is ignored there.
- **xAI** speaks the same Responses API (its Chat Completions endpoint is documented as legacy), so the adapter subclasses the OpenAI one and inherits the stateless defaults above. Differences: `reasoning.effort` caps at `high` (grok-4.3+ only — omit `reasoning` for older models), no `summary` parameter is sent (xAI always returns detailed reasoning summaries), grok models keep `temperature`/`top_p`, and there is no embeddings API.
- **Groq** speaks the **Chat Completions** API (`/openai/v1/chat/completions`) — Groq's Responses API is beta and rejects the `store`/`include` parameters the stateless OpenAI adapter depends on. Reasoning models (gpt-oss, qwen3) always get `reasoning_format: "parsed"`, so thinking arrives in `message.reasoning` → thinking parts (no signature; never replayed). `reasoning.effort` → `reasoning_effort`: gpt-oss grades `low`/`medium`/`high` (`xhigh`/`max` cap to `high`), qwen3 only accepts `none`/`default` so graded efforts are omitted; `enabled: false` → `"none"` (qwen3 only — gpt-oss cannot disable reasoning). Omit `reasoning` for non-reasoning models. Structured output sends `strict: true` (constrained decoding) on gpt-oss and best-effort mode elsewhere; models without `json_schema` support (llama-3.x) reject it. Prompt caching is automatic (`cache_read` in usage details); oversized prompts (413) map to `context_length`; no embeddings API.
- **Modal** is for self-deployed models behind Modal web endpoints (vLLM/SGLang), which speak the **Chat Completions** API. `baseUrl` is required (per-deployment `*.modal.run` URL; or `MODAL_BASE_URL`). Auth is optional and dual-track: `apiKey` → `Authorization: Bearer` (vLLM/SGLang `--api-key`; `MODAL_API_KEY`) and/or `proxyAuth` → `Modal-Key`/`Modal-Secret` headers (Modal Proxy Auth Tokens; `MODAL_KEY`/`MODAL_SECRET`). Responses' `reasoning_content` maps to thinking parts; thinking is never replayed (Chat Completions has no replay format). `reasoning.effort` → `reasoning_effort` (caps at `high`; unsupported servers reject it — omit `reasoning` then), `reasoning.enabled` is ignored (use `providerOptions`, e.g. vLLM `chat_template_kwargs`). Sends `max_tokens` for compatibility; `embed` hits `/v1/embeddings` if the deployment serves an embedding model.
- **Web search** (`webSearch: boolean | WebSearchOptions`): a first-class option, not a `Tool` — it's a server-side tool, so the provider runs the searches and returns a finished answer with `citations` (`{ url, title?, snippet? }[]`, also on the `finish` stream event). `WebSearchOptions` (`maxUses`, `allowedDomains`, `blockedDomains`, `userLocation`, `contextSize`) is the cross-provider subset; each adapter maps what it supports and ignores the rest (provider-specific knobs go through `providerOptions`). Routing: Anthropic/OpenAI/xAI server tools, Gemini Google Search grounding, Groq built-in `browser_search` (gpt-oss; incompatible with structured output) or automatic compound search. Requesting it on a model that can't do web search throws `invalid_request` (Modal never can). Anthropic's `pause_turn` (server tool-loop limit) is resumed transparently, so a single call still returns a finished turn. Citations are a normalized source list (the cross-provider common denominator); provider-specific inline-span data stays in `raw`.
- **Usage**: `input.total` includes cached tokens; breakdown in `details` (`cache_read`, `cache_write`, `reasoning`, and the web-search request count under `web_search_requests` — a billed request tally, not tokens).
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
