# cardan

Unified TypeScript adapter for major LLM provider APIs. Zero runtime dependencies — adapters speak HTTP via native `fetch`. Runs on Node ≥ 20, Deno, and edge runtimes.

See [DESIGN.md](./DESIGN.md) for goals, non-goals, and provider tiers.

## Status

0.x — API is unstable until raven/ticks migrate onto it. Implemented: core schema + Anthropic, OpenAI (Responses API), Google (Gemini API), xAI, Groq, and Modal (self-deployed, Chat Completions) adapters (generate, streaming, tools, structured output, thinking, vision; OpenAI, Google, and Modal also embeddings).

## Providers

Model ids are `prefix/model`. `createCardan()` reads these env vars for each provider (or pass keys explicitly in config):

| Provider  | Prefix      | Env vars                                                       |
| --------- | ----------- | -------------------------------------------------------------- |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` (subscription) |
| OpenAI    | `openai`    | `OPENAI_API_KEY`                                               |
| Google    | `google`    | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`)                         |
| xAI       | `xai`       | `XAI_API_KEY`                                                  |
| Groq      | `groq`      | `GROQ_API_KEY`                                                 |
| Modal     | `modal`     | `MODAL_BASE_URL` (required); `MODAL_API_KEY`, or `MODAL_KEY` + `MODAL_SECRET` |

- **Anthropic auth precedence** (most explicit first): config `oauth` → config `apiKey` → env `CLAUDE_CODE_OAUTH_TOKEN` → env `ANTHROPIC_API_KEY`. `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) bills against a Claude.ai subscription; if both env vars are set, the OAuth token wins and cardan warns. For the full refreshable OAuth flow (rotating tokens), pass `oauth` in config — see [Anthropic `oauth`](#behavior-notes).
- **Google**: cardan prefers `GEMINI_API_KEY`; if both it and `GOOGLE_API_KEY` are set, cardan warns (Google's own `@google/genai` SDK prefers `GOOGLE_API_KEY`, so the two can disagree).

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

### Agent

`cardan.agent(spec)` builds a reusable identity — `{ name, system?, model?, tools?, memory? }` — layered over `Conversation`. The agent holds no runtime of its own; it builds conversations on demand.

`run(input, opts?)` runs one closed task: recall memory → `ask` (auto tool-loop if the agent has tools) → observe → return. Its result's `usage` is the **accumulated** total across every generate the run made (tool-loop rounds included), so reading it gives the task's full cost — unlike a bare `ask`, whose `usage` is only the last turn.

`conversation(opts?)` returns a fresh `Conversation` pre-configured with the agent's identity, for when you want to drive the turns yourself — mid-task or conditional steering is just `ask` between `if`s. It does **not** apply `memory` (the observe timing is undefined under manual driving).

```ts
const analyst = cardan.agent({
  name: "analyst",
  system: "You are a terse market analyst.",
  model: "anthropic/claude-opus-4-8",
  tools: [search],
  memory,                                   // optional; see below
});

const { text, usage } = await analyst.run("Summarize today's ETH moves.");

// or drive the turns yourself for mid-task steering:
const conv = analyst.conversation();
const draft = await conv.ask("Draft the thesis.");
if (offTrack(draft.text)) await conv.ask("Too broad — focus on L2 flows.");
const final = await conv.ask("Finalize it.");
```

`memory` is what an agent carries *between* conversations (a transcript is within one). It's the lightest possible hook — `{ recall(): string; observe(result): void }` — called by `run` (recall before, observe after); where and how to store is yours. No vector store. An agent without `memory` is a stateless identity.

**Orchestration is ordinary async** — there is no flow/graph layer to learn. Multi-step is `await`, branching is `if`, loops are `while`, and fan-out is `parallel(items, fn, { concurrency, signal })` (concurrency-limited, order-preserving, fail-fast, cancellable). Give each branch its own `agent`/`conversation` (or `conversation.fork()`) so transcripts don't collide:

```ts
// screen → investigate N concurrently → publish
const picked = await screener.run(`Pick the noteworthy events:\n${format(candidates)}`, {
  output: { schema: z.object({ ids: z.array(z.string()) }) },
});
const reports = await parallel((picked.output as { ids: string[] }).ids, async (id, _i, signal) => {
  const conv = investigator.conversation();
  await conv.ask(`Research ${id}.`, { tools: [search], compact: true, signal });
  const res = await conv.ask("Emit the report.", { output: { schema: reportSchema }, signal });
  return [id, res.output as Report] as const;
}, { concurrency: 4 }); // ≤ 4 in flight; signal threads into each ask
await publish(Object.fromEntries(reports));
```

### Pool

`createPool({ members })` builds a `PoolProvider` — a `Provider` that rotates over several accounts of the **same** provider and fails over on transient errors. It's for multi-account credential rotation (e.g. several Claude.ai OAuth subscriptions), not cross-provider routing. Use it directly, or inject it: `createCardan({ providers: { anthropic: pool } })`.

`members` accepts bare provider instances; map your credentials straight into them. Use the `{ provider, weight?, label? }` form only when you need a custom weight or label.

```ts
import { AnthropicProvider, createPool } from "cardan";

// one member per Claude setup-token (oauth accepts a bare token string)
const pool = createPool({
  members: tokens.map((token) => new AnthropicProvider({ oauth: token })),
  onFailover: (i) => log.warn(`switch ${i.fromLabel} → ${i.toLabel}: ${i.error.code}`),
});

await pool.generate({ model: "claude-opus-4-8", messages }); // routed to whichever member is up

// mix in weights / labels with the object form where needed
createPool({ members: [primary, { provider: backup, weight: 2, label: "backup" }] });
```

A pool *is* a `Provider`, so it composes anywhere a provider is expected. Inject it under one slot of a `Cardan` while other providers stay single — the `provider/model` prefix routes to it transparently:

```ts
import { AnthropicProvider, OpenAIProvider, createCardan, createPool } from "cardan";

const cardan = createCardan({
  providers: {
    anthropic: createPool({ members: tokens.map((t) => new AnthropicProvider({ oauth: t })) }),
    openai: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }), // single
  },
});

await cardan.generate({ model: "anthropic/claude-opus-4-8", messages }); // → the pool
await cardan.generate({ model: "openai/gpt-5.5", messages });            // → the single provider
```

Because a pool is just a `Provider`, it also nests: a `PoolProvider` can itself be a member of another pool (e.g. group several account pools), and the `Conversation`/`Agent` layers accept it wherever they accept a `Cardan` or provider.

- **Rotation**: a fixed, evenly-interleaved round-robin built from member `weight`s (default 1); each request takes the next slot.
- **Failover**: on a `rate_limit | auth | server | network | timeout` error it switches to the next *distinct* member and retries (the pool owns this retry, so per-attempt provider retry is disabled while ≥2 members are tried). `maxFailovers` caps switches; `shouldFailover` customizes which errors qualify. For `stream`, a switch is only possible before the first event is emitted.
- **Cooldown**: a failed member is skipped on later requests until it recovers, with a scope that matches the error's signal. An absolute `resetAt` (exact, uncapped — e.g. Anthropic's *account-wide* subscription window reset, read from the `anthropic-ratelimit-unified-reset` response header) cools the **whole member across every model**. A relative `Retry-After` (whose limit may be per-model, e.g. OpenAI TPM) cools **only that model**, so a 429 on `opus` doesn't sideline the account for `sonnet` (capped by `maxCooldownMs`, default 15 min). With neither signal the member is not cooled (failover only) — a transient fault isn't necessarily an account problem. Cooled members thaw automatically when the deadline passes.
- **All cooling**: if every member is cooling for the model, the pool tries the soonest-to-recover one as a last-ditch attempt (it may have reset early), then throws a `rate_limit` `CardanError` naming the soonest recovery time (`retryAfterMs` set accordingly).

## Behavior notes

- **Message normalization** (applied before every request): consecutive same-role messages merge; `tool_result` parts are relocated into a `tool` message directly after their `tool_call`, in call order; a dangling `tool_call` (no result) gets a synthesized error result (`isError: true`) so aborted conversations stay replayable; an orphan or duplicate `tool_result` throws `invalid_request`.
- **System messages**: leading system messages hoist to the provider's top-level system field (Anthropic `system`, Gemini `systemInstruction`); mid-conversation system messages downgrade to user text. OpenAI's Responses API accepts `system` anywhere in `input`, so system messages pass through in place.
- **Anthropic `oauth`**: pass `{ oauth: { credentials: { accessToken, refreshToken?, expiresAt? }, onRefresh? } }` to authenticate with a Claude.ai OAuth token instead of `apiKey`, or a bare token string (`{ oauth: token }`) as shorthand for `{ credentials: { accessToken: token } }` — handy for a `claude setup-token` token. Sends Bearer auth, refreshes before expiry (persist the rotated token via `onRefresh`), and retries once on 401. On a subscription rate-limit (429) the adapter reads the exact window reset from the `anthropic-ratelimit-unified-reset` response header into `CardanError.resetAt` (epoch ms) — this is what gives a [Pool](#pool) precise per-account cooldowns, and it works even for an inference-only `claude setup-token` (unlike the `/api/oauth/usage` endpoint, which needs the `user:profile` scope).
- **OpenAI is stateless by default**: every request sends `store: false` + `include: ["reasoning.encrypted_content"]`; context is replayed from `messages` and reasoning items survive multi-turn tool use via `encrypted_content` (held in `ThinkingPart.signature` with the item id in `ThinkingPart.id`). Override via `providerOptions`. The Responses API has no stop-sequence parameter, so `stopSequences` is ignored there.
- **Background mode** (`background?: boolean`, OpenAI/xAI Responses only): keeps long high-effort generations from dropping on idle-connection timeouts by decoupling execution from the HTTP connection. `undefined` (default) auto-enables it for `high`/`xhigh`/`max` reasoning effort; `true`/`false` force it. It forces `store: true` (so it's not ZDR-compatible; data is retained ~10 min): `generate` creates the response then polls `GET /v1/responses/{id}` to completion, and `stream` transparently resumes a dropped SSE via `starting_after`. Other providers ignore the flag (use streaming for long requests there). The total time is bounded by your `signal`.
- **xAI** speaks the same Responses API (its Chat Completions endpoint is documented as legacy), so the adapter subclasses the OpenAI one and inherits the stateless defaults and background mode above. Differences: `reasoning.effort` caps at `high` (grok-4.3+ only — omit `reasoning` for older models), no `summary` parameter is sent (xAI always returns detailed reasoning summaries), grok models keep `temperature`/`top_p`, and there is no embeddings API.
- **Groq** speaks the **Chat Completions** API (`/openai/v1/chat/completions`) — Groq's Responses API is beta and rejects the `store`/`include` parameters the stateless OpenAI adapter depends on. Reasoning models (gpt-oss, qwen3) always get `reasoning_format: "parsed"`, so thinking arrives in `message.reasoning` → thinking parts (no signature; never replayed). `reasoning.effort` → `reasoning_effort`: gpt-oss grades `low`/`medium`/`high` (`xhigh`/`max` cap to `high`), qwen3 only accepts `none`/`default` so graded efforts are omitted; `enabled: false` → `"none"` (qwen3 only — gpt-oss cannot disable reasoning). Omit `reasoning` for non-reasoning models. Structured output sends `strict: true` (constrained decoding) on gpt-oss and best-effort mode elsewhere; models without `json_schema` support (llama-3.x) reject it. Prompt caching is automatic (`cache_read` in usage details); oversized prompts (413) map to `context_length`; no embeddings API.
- **Modal** is for self-deployed models behind Modal web endpoints (vLLM/SGLang), which speak the **Chat Completions** API. `baseUrl` is required (per-deployment `*.modal.run` URL; or `MODAL_BASE_URL`). Auth is optional and dual-track: `apiKey` → `Authorization: Bearer` (vLLM/SGLang `--api-key`; `MODAL_API_KEY`) and/or `proxyAuth` → `Modal-Key`/`Modal-Secret` headers (Modal Proxy Auth Tokens; `MODAL_KEY`/`MODAL_SECRET`). Responses' `reasoning_content` maps to thinking parts; thinking is never replayed (Chat Completions has no replay format). `reasoning.effort` → `reasoning_effort` (caps at `high`; unsupported servers reject it — omit `reasoning` then), `reasoning.enabled` is ignored (use `providerOptions`, e.g. vLLM `chat_template_kwargs`). Sends `max_tokens` for compatibility; `embed` hits `/v1/embeddings` if the deployment serves an embedding model.
- **Web search** (`webSearch: boolean | WebSearchOptions`): a first-class option, not a `Tool` — it's a server-side tool, so the provider runs the searches and returns a finished answer with `citations` (`{ url, title?, snippet? }[]`, also on the `finish` stream event). `WebSearchOptions` (`maxUses`, `allowedDomains`, `blockedDomains`, `userLocation`, `contextSize`) is the cross-provider subset; each adapter maps what it supports and ignores the rest (provider-specific knobs go through `providerOptions`). Routing: Anthropic/OpenAI/xAI server tools, Gemini Google Search grounding, Groq built-in `browser_search` (gpt-oss; incompatible with structured output) or automatic compound search. Requesting it on a model that can't do web search throws `invalid_request` (Modal never can). Anthropic's `pause_turn` (server tool-loop limit) is resumed transparently, so a single call still returns a finished turn. Citations are a normalized source list (the cross-provider common denominator); provider-specific inline-span data stays in `raw`.
- **Usage**: `input.total` includes cached tokens; breakdown in `details` (`cache_read`, `cache_write`, `reasoning`, and the web-search request count under `web_search_requests` — a billed request tally, not tokens).
- **Retry**: 429/529/5xx/network errors retry with exponential backoff (default 2 retries), honoring `Retry-After` (and Gemini's `RetryInfo.retryDelay`). Disable with `retry: false`. Streams only retry before the first byte.
- **Timeout**: `timeoutMs` (per request, or a provider-option default — per-request wins) bounds each HTTP attempt; retries reset it, and `undefined`/`0` (default) means no timeout. A timeout aborts with a retryable `CardanError` (`code: "timeout"`), distinct from a caller-`signal` abort (`code: "aborted"`, not retried). It bounds the wait until the response begins (headers arrive): for non-streaming `generate` the server only responds once generation finishes, so this effectively caps total generation time; for `stream` it bounds connection setup only (bound a mid-stream stall with `signal`). For a hard ceiling across retries, pass `signal: AbortSignal.timeout(ms)`.
- **Capability table**: models that reject sampling params (Fable 5 / Mythos 5 / Opus 4.7+, OpenAI o-series / non-chat gpt-5*) have `temperature`/`topP` dropped silently; Gemini 3 maps `reasoning.effort` to `thinkingLevel`, Gemini 2.x to `thinkingBudget`.
- **`reasoning`**: `{ enabled: true }` → Anthropic adaptive thinking / Gemini `includeThoughts` / OpenAI `reasoning.summary: "auto"`; `effort` → Anthropic `output_config.effort` / Gemini thinking level or budget / OpenAI `reasoning.effort` (`max` caps to `xhigh`; `enabled: false` → `effort: "none"`, gpt-5.1+ only). Use `providerOptions` for anything provider-specific (e.g. beta headers go in provider `headers`).
- **Thinking parts**: replayed with their `signature`; unsigned thinking parts are dropped on send; `redacted: true` maps to Anthropic `redacted_thinking`.
- **Tool call ids**: provider-assigned ids are preserved verbatim. Gemini 2.x omits function-call ids, so the adapter synthesizes `cardan_call_…` ids for pairing and strips them on replay; Gemini `thoughtSignature`s ride on `signature` of text/thinking/tool_call parts and are required for Gemini 3 function-calling replay (preserved identically in streaming and non-streaming — see below).
- **Gemini files**: image/file input supports inline bytes (`inlineData`) and `URL` → `fileData.fileUri` passthrough (Files API URIs); cardan does not wrap the File API itself. `embed` uses `batchEmbedContents`, which returns no usage metadata.
- **Errors**: all failures are `CardanError` with `code` (`auth` / `rate_limit` / `overloaded` / `context_length` / `invalid_request` / `not_found` / `server` / `network` / `timeout` / `aborted` / `unknown`), `status`, `retryable`, `retryAfterMs` (relative, from `Retry-After`), `resetAt` (absolute epoch ms, when the provider reports an exact rate-limit reset), and the raw provider body in `raw`.

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
