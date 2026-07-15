# cardan

Unified TypeScript adapter for major LLM provider APIs. Zero runtime dependencies — adapters speak HTTP via native `fetch`. Runs on Node ≥ 20, Deno, and edge runtimes.

See [docs/design.md](./docs/design.md) for goals, non-goals, and provider tiers (full design notes in [docs/](./docs/)).

## Status

0.x — unstable until raven/ticks migrate onto it. Implemented: core schema + Anthropic, OpenAI (Responses API), Google (Gemini API), xAI, Groq, and Modal (self-deployed, Chat Completions) adapters — generate, streaming, tools, structured output, thinking, vision; OpenAI/Google/Modal also embeddings.

## Providers

Model ids are `prefix/model`. `createCardan()` reads these env vars per provider (or pass keys explicitly):

| Provider  | Prefix      | Env vars                                                       |
| --------- | ----------- | -------------------------------------------------------------- |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` (subscription) |
| OpenAI    | `openai`    | `OPENAI_API_KEY`                                               |
| Google    | `google`    | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`)                         |
| xAI       | `xai`       | `XAI_API_KEY`, or `GROK_BUILD_OAUTH_TOKEN` (subscription — see [xAI Grok subscription](#xai-grok-subscription-grok-login)) |
| Groq      | `groq`      | `GROQ_API_KEY`                                                 |
| Modal     | `modal`     | `MODAL_BASE_URL` (required); `MODAL_API_KEY`, or `MODAL_KEY` + `MODAL_SECRET` |

- **Anthropic auth precedence** (most explicit first): config `oauth` → config `apiKey` → env `CLAUDE_CODE_OAUTH_TOKEN` → env `ANTHROPIC_API_KEY`. `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) bills against a Claude.ai subscription; if both env vars are set, the OAuth token wins and cardan warns. For the full refreshable OAuth flow, pass `oauth` in config — see [Anthropic `oauth`](#behavior-notes).
- **xAI auth precedence** (most explicit first): config `xaiOAuth` → config `xai.apiKey` → env `GROK_BUILD_OAUTH_TOKEN` (Grok Build subscription) → env `XAI_API_KEY`. If both env vars are set, the OAuth token wins and cardan warns. A bare env token is inference-only (no refresh); pass `xaiOAuth` for the refreshable flow.
- **Google**: prefers `GEMINI_API_KEY`; if both it and `GOOGLE_API_KEY` are set, cardan warns (Google's own `@google/genai` prefers `GOOGLE_API_KEY`, so the two can disagree).

## CLI

`npx cardan@latest detect` finds local Claude Code and Grok CLI subscription credentials and prints account info plus a ready-to-paste `.env` block; add `--all-users` to scan every readable account's home. It is read-only and never refreshes tokens. Runs on Linux, macOS, and Windows. Details in [docs/cli.md](./docs/cli.md).

> **The output contains live access tokens** — treat stdout as a secret. Don't pipe it into shared logs or CI output, and note that `--all-users` can print other accounts' tokens (e.g. when run as root).

```
Anthropic (Claude Code)
  file           ~/.claude/.credentials.json
  subscription   pro · default_claude_ai
  access token   valid · expires 2026-07-12 18:42 UTC
  refresh token  present · expires 2026-08-06 21:11 UTC

# .env — cardan reads these automatically
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…
GROK_BUILD_OAUTH_TOKEN=eyJ0…
```

Programmatically, `detectCredentials()` and `detectAllUsers()` return the same detection as structured data (rendering stays in the CLI).

### Local OAuth (long-running services)

`detect` is read-only. For a service that should stay logged in, use **`loadLocalOAuth` / `localOAuthPool`**: they build providers from the same CLI files, wire `onRefresh` to write rotated tokens back, and optionally merge bare env tokens (deduped — file wins).

```ts
import { createCardan, localOAuthPool, loadLocalOAuthPrefix } from "cardan";

// Env families auto-expand: BASE, BASE1, BASE2, … BASE10 — set as many as you need.
// Default `env: true` uses CLAUDE_CODE_OAUTH_TOKEN / GROK_BUILD_OAUTH_TOKEN as bases.
const anthropic = await localOAuthPool("anthropic", {
  files: false, // setup-token env only (not ~/.claude login session)
});

const xaiMembers = await loadLocalOAuthPrefix("xai"); // file + env family, file wins on dedupe
// xaiMembers[i].provider is XAIOAuthProvider (subscriptionUsage, …)

const cardan = createCardan({
  providers: {
    ...(anthropic ? { anthropic } : {}),
    ...(xaiMembers.length
      ? {
          xai: await localOAuthPool("xai"), // or createPool from xaiMembers
        }
      : {}),
  },
});
```

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
// result.rateLimit: subscription quota snapshot from response headers, when reported (see Behavior notes)

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

`collectStream(stream)` accumulates a stream into a `GenerateResult` (message + finishReason + usage); `collectStreamToMessage(stream)` returns just the assistant `Message`, ready to push into the next request. See [Reasoning / thinking state](#reasoning--thinking-state).

### xAI Grok subscription (`grok login`)

Bill against a **SuperGrok subscription** instead of the pay-per-token API. Install the Grok CLI (`https://x.ai/cli/install.sh`), run `grok login`, then set the `eyJ0…` token from `~/.grok/auth.json` as `GROK_BUILD_OAUTH_TOKEN` — `createCardan()` auto-wraps it into credentials, so `xai/grok-4.5` just works:

```bash
export GROK_BUILD_OAUTH_TOKEN=$(jq -r '.[]|select(.key).key' ~/.grok/auth.json | head -1)
```

For the refreshable flow (`refresh_token`, `onRefresh`, `clientVersion`) pass `xaiOAuth` / `new XAIOAuthProvider(...)`. Design + wire details: [docs/providers.md](docs/providers.md).

### Conversation

`cardan.conversation(options)` returns a stateful `Conversation` that holds a running transcript and collapses "push user → generate → push assistant" into one `ask`. Every generation option (`model`, `reasoning`, `tools`, …) is a default on `defaults`, overridable per turn and reassignable mid-conversation — `model` is not privileged.

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

c.defaults.model = "openai/gpt-5.6-terra"; // switch model for all later turns
```

`ask` adds a user turn, generates, appends the reply, returns the `GenerateResult`; with `tools` it loops (`maxRounds` caps it, forcing a tool-free conclusion on the last round). Structured output is a plain option (`output.schema`) — `res.output` holds the parsed value; cast it with `Infer<typeof schema>` for the static type. `output` and `tools` can't combine in one `ask` (structured output is constrained decoding, which blocks tool calls, so `ask` throws) — run the tool loop first, then ask again with `output`. cardan logs nothing itself: pass `onCall` for per-call telemetry (`tag`, `model`, `ms`, `usage`, `citations`, `finishReason` on success / `error` on failure).

`compact` keeps a tool-using turn from bloating later context. The default compactor (`redactToolResults`) keeps the tool-call/result structure — so the model still sees it reached the conclusion *by using tools*, not as innate knowledge — but replaces each result's payload with a short placeholder (this also keeps raw page content from tripping provider filters on replay). Pass your own `Compactor` (`(region: Message[]) => Message[]`) to customize, e.g. the built-in `dropToolRounds` (keep only the conclusion) or an LLM-written summary.

`fork(overrides?)` branches a conversation: the copy shares the client/defaults but gets an independent transcript, so diverging turns never touch the original — use it before fanning out in parallel (a shared mutable transcript would corrupt).

### Agent

`cardan.agent(spec)` builds a reusable identity — `{ name, system?, model?, tools?, memory? }` — layered over `Conversation`. It holds no runtime of its own; it builds conversations on demand.

`run(input, opts?)` runs one closed task: recall memory → `ask` (auto tool-loop if the agent has tools) → observe → return. Its `usage` is the **accumulated** total across every generate the run made (tool-loop rounds included), so it gives the task's full cost — unlike a bare `ask`, whose `usage` is only the last turn.

`conversation(opts?)` returns a fresh `Conversation` pre-configured with the agent's identity, to drive the turns yourself — mid-task or conditional steering is just `ask` between `if`s. It does **not** apply `memory` (observe timing is undefined under manual driving).

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

`createPool({ members })` builds a `PoolProvider` — a `Provider` that rotates over several accounts of the **same** provider and fails over on transient errors. For multi-account credential rotation (e.g. several Claude.ai OAuth subscriptions), not cross-provider routing. Use it directly, or inject it: `createCardan({ providers: { anthropic: pool } })`.

`members` accepts bare provider instances; map your credentials straight into them. Use the `{ provider, weight?, label? }` form only for a custom weight or label.

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

A pool *is* a `Provider`, so it composes anywhere a provider is expected. Inject it under one slot of a `Cardan` while others stay single — the `provider/model` prefix routes transparently:

```ts
import { AnthropicProvider, OpenAIProvider, createCardan, createPool } from "cardan";

const cardan = createCardan({
  providers: {
    anthropic: createPool({ members: tokens.map((t) => new AnthropicProvider({ oauth: t })) }),
    openai: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }), // single
  },
});

await cardan.generate({ model: "anthropic/claude-opus-4-8", messages }); // → the pool
await cardan.generate({ model: "openai/gpt-5.6-sol", messages });        // → the single provider
```

A pool also nests: a `PoolProvider` can itself be a member of another pool (e.g. group several account pools), and the `Conversation`/`Agent` layers accept it wherever they accept a `Cardan` or provider.

### Telemetry

`createCardan({ telemetry: { onRequest } })` observes every logical request at the routing layer — once per `generate` / `stream` / `embed`, after pool failover and per-attempt retries. No call-site instrumentation needed. Absent `telemetry` is a no-op.

```ts
const cardan = createCardan({
  telemetry: {
    onRequest(event) {
      // event: { provider, model, op, ok, durationMs, usage?, errorCode?, status?, … }
      metrics.record(event);
    },
  },
});
```

- **`provider`** is the routing prefix (`"anthropic"` even when that slot holds a pool); **`model`** is the id without the prefix.
- **Success**: `ok: true`; `generate` includes `result.usage`; `stream` includes the `finish` event's usage; `embed` omits usage.
- **Failure**: `ok: false` with `errorCode` (and `status` / `retryAfterMs` / `resetAt` when the error is a `CardanError`); the original error is rethrown.
- **Stream abandon**: if the consumer stops iterating before `finish`, one event fires with `ok: true` and no usage (not treated as an error). `durationMs` starts at the first `next()`.
- Observer exceptions are swallowed so a broken sink cannot break requests.

This is separate from Conversation's per-`ask` `onCall` telemetry (turn-level, with labels/steps).

- **Rotation**: a fixed, evenly-interleaved round-robin built from member `weight`s (default 1); each request takes the next slot.
- **Failover**: on a `rate_limit | auth | server | network | timeout` error it switches to the next *distinct* member and retries (the pool owns this retry, so per-attempt provider retry is disabled while ≥2 members are tried, and also on an all-cooling last-ditch attempt). `maxFailovers` caps switches; `shouldFailover` customizes which errors qualify. For `stream`, a switch is only possible before the first event.
- **Cooldown**: a failed member is skipped on later requests until it recovers, scoped to the error's signal. An absolute `resetAt` (exact, uncapped — e.g. Anthropic's *account-wide* subscription window reset, read from the `anthropic-ratelimit-unified-reset` header) cools the **whole member across every model**. A relative `Retry-After` (limit may be per-model, e.g. OpenAI TPM) cools **only that model**, so a 429 on `opus` doesn't sideline `sonnet` (capped by `maxCooldownMs`, default 15 min). With neither signal, no cooldown (failover only) — a transient fault isn't necessarily an account problem. Cooled members thaw automatically when the deadline passes.
- **All cooling**: if every member is cooling for the model, the pool tries the soonest-to-recover one as a last-ditch attempt (it may have reset early), then throws a `rate_limit` `CardanError` naming the soonest recovery time.
- **Quota observability**: `pool.rateLimits()` returns each member's last-known quota snapshot (`{ label, rateLimit }`). Observation only — the pool won't sideline a member that still has quota; act on it yourself.

## Behavior notes

- **Message normalization** (before every request): consecutive same-role messages merge; `tool_result` parts relocate into a `tool` message directly after their `tool_call`, in call order; a dangling `tool_call` gets a synthesized error result (`isError: true`) so aborted conversations stay replayable; an orphan or duplicate `tool_result` throws `invalid_request`.
- **System messages**: leading system messages hoist to the provider's top-level field (Anthropic `system`, Gemini `systemInstruction`); mid-conversation ones downgrade to user text. OpenAI's Responses API accepts `system` anywhere, so they pass through in place.
- **Anthropic `oauth`**: pass `{ oauth: { credentials: { accessToken, refreshToken?, expiresAt? }, onRefresh? } }` to authenticate with a Claude.ai OAuth token instead of `apiKey`, or a bare token string (`{ oauth: token }`) as shorthand for `{ credentials: { accessToken: token } }` — handy for a `claude setup-token` token. Sends Bearer auth, refreshes before expiry (persist the rotated token via `onRefresh`), and retries once on 401/403 — skipping a redundant refresh if a concurrent request already rotated the token. A failing `onRefresh` is surfaced as a warning but never aborts the request (the in-memory token is valid; only the on-disk rotation is lost). On a subscription 429 the adapter reads the exact window reset from the `anthropic-ratelimit-unified-reset` header into `CardanError.resetAt` (epoch ms) — this gives a [Pool](#pool) precise per-account cooldowns, and works even for an inference-only `claude setup-token` (unlike `/api/oauth/usage`, which needs the `user:profile` scope). The same lifecycle backs xAI's `xaiOAuth`.
- **OAuth tokens: env vs config**: the env vars (`CLAUDE_CODE_OAUTH_TOKEN`, `GROK_BUILD_OAUTH_TOKEN`) are consumed as a **non-refreshable** bearer — the token is sent verbatim and goes stale at its expiry (a refresh token can't be substituted; it is only valid at the token endpoint, not the inference API). For a durable env token use one built to be long-lived (`claude setup-token`). For automatic freshness, use the **config** `oauth`/`xaiOAuth` object with `refreshToken` + `onRefresh` instead: refresh rotates the refresh token, which must be persisted to a writable store, so the file-backed config flow — not the read-only env path — is what keeps a long-running service fresh. File-backed members from `loadLocalOAuth` re-read their credential file before each refresh and adopt externally rotated tokens (e.g. by the official CLI) without a token-endpoint call, so sharing the file with the CLI is safe. Caveat: two processes each refreshing against one credential file between reloads can still rotate out from under each other; keep a single owner of refresh where possible.
- **Subscription rate limit** (`result.rateLimit`): Anthropic's unified rate-limit headers ride on every response (no special scope), parsed into a `RateLimitStatus` — the `representative` window plus per-window `fiveHour`/`sevenDay` (`utilization`, `resetAt`, `status`). Also on the stream `finish` event; `provider.rateLimit` keeps the last-known snapshot (a live quota view, not a token accumulator — that's `usage`). `undefined` for API-key requests. Observation only — nothing acts on it (the [Pool](#pool) cools on real 429s); read per-account via `pool.rateLimits()`.
- **OpenAI is stateless by default**: every request sends `store: false` + `include: ["reasoning.encrypted_content"]`; context replays from `messages` and reasoning items survive multi-turn tool use via `encrypted_content` (held in `ThinkingPart.signature`, item id in `ThinkingPart.id`). Override via `providerOptions`. The Responses API has no stop-sequence parameter, so `stopSequences` is ignored.
- **Background mode** (`background?: boolean`, OpenAI Responses only): keeps long high-effort generations from dropping on idle-connection timeouts by decoupling execution from the HTTP connection. `undefined` (default) auto-enables it for `high`/`xhigh`/`max` reasoning effort; `true`/`false` force it. It forces `store: true` (so not ZDR-compatible; data retained ~10 min): `generate` creates the response then polls `GET /v1/responses/{id}` to completion, and `stream` transparently resumes a dropped SSE via `starting_after`. Other providers (including xAI) ignore the flag (use streaming there). Total time is bounded by your `signal`.
- **xAI** speaks the same Responses API (its Chat Completions endpoint is legacy), so the adapter subclasses the OpenAI one and inherits the stateless defaults. Differences: `background` is never sent (xAI rejects it — `Argument not supported: background`), `reasoning.effort` accepts `low`/`medium`/`high` (`none` is rejected, so reasoning cannot be disabled — the field is omitted instead; `xhigh`/`max` cap to `high`), no `summary` is sent (xAI always returns detailed reasoning summaries), grok models keep `temperature`/`top_p`, and there is no embeddings API.
- **Groq** speaks the **Chat Completions** API (`/openai/v1/chat/completions`) — its Responses API is beta and rejects the `store`/`include` the stateless OpenAI adapter depends on. Reasoning models (gpt-oss, qwen3) always get `reasoning_format: "parsed"`, so thinking arrives in `message.reasoning` → thinking parts (no signature; never replayed). `reasoning.effort` → `reasoning_effort`: gpt-oss grades `low`/`medium`/`high` (`xhigh`/`max` cap), qwen3 only accepts `none`/`default` so graded efforts are omitted; `enabled: false` → `"none"` (qwen3 only — gpt-oss can't disable reasoning). Omit `reasoning` for non-reasoning models. Structured output sends `strict: true` on gpt-oss, best-effort elsewhere; models without `json_schema` support (llama-3.x) reject it. Prompt caching is automatic (`cache_read`); oversized prompts (413) map to `context_length`; no embeddings API.
- **Modal** is for self-deployed models behind Modal web endpoints (vLLM/SGLang), which speak the **Chat Completions** API. `baseUrl` is required (per-deployment `*.modal.run` URL; or `MODAL_BASE_URL`). Auth is optional and dual-track: `apiKey` → `Authorization: Bearer` (vLLM/SGLang `--api-key`; `MODAL_API_KEY`) and/or `proxyAuth` → `Modal-Key`/`Modal-Secret` headers (Modal Proxy Auth Tokens; `MODAL_KEY`/`MODAL_SECRET`). `reasoning_content` maps to thinking parts; thinking is never replayed (Chat Completions has no replay format). `reasoning.effort` → `reasoning_effort` (caps at `high`; unsupported servers reject it — omit `reasoning` then), `reasoning.enabled` is ignored (use `providerOptions`, e.g. vLLM `chat_template_kwargs`). Sends `max_tokens`; `embed` hits `/v1/embeddings` if the deployment serves an embedding model.
- **Web search** (`webSearch: boolean | WebSearchOptions`): a first-class option, not a `Tool` — it's server-side, so the provider runs the searches and returns a finished answer with `citations` (`{ url, title?, snippet? }[]`, also on the `finish` stream event). `WebSearchOptions` (`maxUses`, `allowedDomains`, `blockedDomains`, `userLocation`, `contextSize`) is the cross-provider subset; each adapter maps what it supports (provider-specific knobs via `providerOptions`). Routing: Anthropic/OpenAI/xAI server tools, Gemini Google Search grounding, Groq built-in `browser_search` (gpt-oss; incompatible with structured output) or automatic compound search. Requesting it on a model that can't do web search throws `invalid_request` (Modal never can). Anthropic's `pause_turn` (server tool-loop limit) is resumed transparently, so a single call still returns a finished turn. Citations are a normalized source list; provider-specific inline-span data stays in `raw`.
- **Usage**: `input.total` includes cached tokens; breakdown in `details` (`cache_read`, `cache_write`, `reasoning`, and `web_search_requests` — a billed request tally, not tokens).
- **Retry**: 429/529/5xx/network errors retry with exponential backoff (default 2 retries), honoring `Retry-After` up to `maxDelayMs` (and Gemini's `RetryInfo.retryDelay`). Anthropic subscription 429s that carry a window `resetAt` are **not** retried (fail over or surface immediately). Disable with `retry: false`. Streams only retry before the first byte.
- **Timeout**: `timeoutMs` (per request, or a provider-option default — per-request wins) bounds each HTTP attempt; retries reset it, and `undefined`/`0` (default) means no timeout. A timeout aborts with a retryable `CardanError` (`code: "timeout"`), distinct from a caller-`signal` abort (`code: "aborted"`, not retried). It bounds the wait until the response begins (headers arrive): for non-streaming `generate` this effectively caps total generation time; for `stream` it bounds connection setup only (bound a mid-stream stall with `signal`). For a hard ceiling across retries, pass `signal: AbortSignal.timeout(ms)`.
- **Capability table**: models that reject sampling params (Fable 5 / Mythos 5 / Opus 4.7+, OpenAI o-series / non-chat gpt-5*) have `temperature`/`topP` dropped silently; Gemini 3 maps `reasoning.effort` to `thinkingLevel`, Gemini 2.x to `thinkingBudget`.
- **`reasoning`**: `{ enabled: true }` → Anthropic adaptive thinking / Gemini `includeThoughts` / OpenAI `reasoning.summary: "auto"`; `effort` is mapped per model (OpenAI: gpt-5.6 keeps distinct `max`, Codex tops at `xhigh`, o-series at `high`; xAI grok-4.5+ caps at `high`; Anthropic adaptive passes effort through, older lines map to `budget_tokens`). `enabled: false` → OpenAI `effort: "none"` (gpt-5.1+ only; o-series/Codex omit), Anthropic `thinking: { type: "disabled" }` where supported (Sonnet 5 needs it because adaptive is default-on; Fable/Mythos cannot disable). Provider-specific via `providerOptions` (e.g. beta headers in provider `headers`).
- **Thinking parts**: replayed with their `signature`; unsigned ones are dropped on send; `redacted: true` maps to Anthropic `redacted_thinking`.
- **Tool call ids**: provider-assigned ids are preserved verbatim. Gemini 2.x omits function-call ids, so the adapter synthesizes `cardan_call_…` ids for pairing and strips them on replay; Gemini `thoughtSignature`s ride on `signature` of text/thinking/tool_call parts and are required for Gemini 3 function-calling replay.
- **Gemini files**: image/file input supports inline bytes (`inlineData`) and `URL` → `fileData.fileUri` passthrough (Files API URIs); cardan does not wrap the File API. `embed` uses `batchEmbedContents`, which returns no usage metadata.
- **Errors**: all failures are `CardanError` with `code` (`auth`/`rate_limit`/`overloaded`/`context_length`/`invalid_request`/`not_found`/`server`/`network`/`timeout`/`aborted`/`unknown`), `status`, `retryable`, `retryAfterMs` (relative, from `Retry-After`), `resetAt` (absolute epoch ms, when the provider reports an exact reset), and the raw provider body in `raw`.

## Reasoning / thinking state

Providers return opaque reasoning state that must be replayed verbatim for multi-turn / tool-use loops to keep working. cardan normalizes it onto `ThinkingPart`/`TextPart`/`ToolCallPart` and replays it to the **same** provider:

- **Anthropic** — `thinking` blocks carry `signature`; `redacted_thinking` carries opaque `data` (mapped to `signature` with `redacted: true`). Both are replayed unchanged and in order; unsigned thinking is dropped on send.
- **OpenAI / xAI** — stateless by default (`store: false` + `include: ["reasoning.encrypted_content"]`). The encrypted reasoning item is held in `ThinkingPart.signature`, its id in `ThinkingPart.id`; both are required to replay, so summary-only thinking (no `encrypted_content`) is dropped. For server-side state instead, pass `previous_response_id` via `providerOptions`.
- **Gemini** — every `Part` (text, thought, or `functionCall`) may carry a `thoughtSignature`; it rides on `signature` and is sent back on the original Part. Signed Parts are never merged with each other or with unsigned Parts. Function-call `id`s are preserved and echoed in the matching `functionResponse`.

**Streaming and non-streaming preserve the same replay-critical state.** Signatures, encrypted reasoning content, ids, and tool-call signatures all survive collection identically.

Use **`collectStream(stream)`** / **`collectStreamToMessage(stream)`** to capture a streamed turn — they reassemble the parts (including signatures) correctly. If you consume stream events yourself, retain the `signature` field on `text_delta`/`thinking_delta` deltas, `thinking_signature` events, and `tool_call` event signatures; dropping them loses reasoning state and breaks the next turn. Push the collected `Message` back into `messages` as-is — don't reduce a tool-use turn to its text.

Opaque state is provider-specific: replay a reasoning-bearing turn to the **same** provider that produced it. cardan does not strip foreign signatures, so feeding one provider's thinking parts to another sends invalid opaque state — start a fresh turn (or drop the thinking parts) when switching providers mid-conversation.

## Development

```sh
npm install
npm run typecheck
npm test        # fixture unit tests (no network)
npm run build
```
