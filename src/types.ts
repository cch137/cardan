import type { SchemaInput } from "./schema.js";

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type Role = "system" | "user" | "assistant" | "tool";

export interface TextPart {
  type: "text";
  text: string;
  /**
   * Opaque provider replay metadata attached to this part (Gemini
   * `thoughtSignature`). Preserved verbatim and sent back when replaying to
   * the same provider; other providers ignore it.
   */
  signature?: string;
}

export interface ImagePart {
  type: "image";
  mimeType: string;
  data: Uint8Array | URL;
}

export interface ToolCallPart {
  type: "tool_call";
  /**
   * Provider-assigned call id (e.g. `toolu_…`, `call_…`). Preserved verbatim.
   * Providers that omit ids (Gemini 2.x) get a synthesized `cardan_call_…`
   * id, which the adapter strips when replaying to that provider.
   */
  id: string;
  name: string;
  args: unknown;
  /**
   * Opaque provider replay metadata attached to this part (Gemini
   * `thoughtSignature`; mandatory for Gemini 3 function-calling replay).
   */
  signature?: string;
}

export interface ToolResultPart {
  type: "tool_result";
  /** Must match the `id` of the corresponding tool_call. */
  callId: string;
  result: unknown;
  isError?: boolean;
}

export interface ThinkingPart {
  type: "thinking";
  text: string;
  /**
   * Provider item id (OpenAI `rs_…`). OpenAI replay requires both `id` and
   * `signature`; parts missing either are dropped when replaying there.
   */
  id?: string;
  /**
   * Provider signature required to replay the thinking block (Anthropic
   * signature, OpenAI `encrypted_content`). Thinking parts without a
   * signature are dropped when replaying to providers that require one.
   */
  signature?: string;
  /**
   * True when the provider returned the block in redacted/encrypted form
   * (Anthropic `redacted_thinking`); `signature` then holds the opaque data.
   */
  redacted?: boolean;
}

export type ContentPart =
  | TextPart
  | ImagePart
  | ToolCallPart
  | ToolResultPart
  | ThinkingPart;

export interface Message {
  role: Role;
  content: ContentPart[];
}

/** Convenience constructor: wraps a string into a single text part. */
export function textMessage(role: Role, text: string): Message {
  return { role, content: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * Token usage. Totals always present; provider-specific breakdowns go in
 * `details` (e.g. `cache_read`, `cache_write`, `reasoning`). Missing fields
 * are treated as 0.
 */
export interface Usage {
  input: { total: number; details: Record<string, number> };
  output: { total: number; details: Record<string, number> };
}

export function emptyUsage(): Usage {
  return {
    input: { total: 0, details: {} },
    output: { total: 0, details: {} },
  };
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export type FinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "refusal"
  | "other";

export type StreamEvent =
  /**
   * A run of visible text. `signature` (Gemini `thoughtSignature`) closes the
   * text part: it carries opaque replay state, so collection must not merge
   * further deltas into a signed part.
   */
  | { type: "text_delta"; text: string; signature?: string }
  /** A run of thinking-summary text; `signature` closes the part (see above). */
  | { type: "thinking_delta"; text: string; signature?: string }
  /** Emitted when a thinking block closes with a replay signature. */
  | { type: "thinking_signature"; signature: string; id?: string }
  /** Emitted once per tool call, when its arguments are complete. */
  | { type: "tool_call"; id: string; name: string; args: unknown; signature?: string }
  | {
      type: "finish";
      reason: FinishReason;
      usage: Usage;
      /** Web-search sources gathered this turn, if web search ran. */
      citations?: WebCitation[];
    };

export interface Tool {
  name: string;
  description?: string;
  /** JSON Schema object or zod schema describing the arguments. */
  parameters?: SchemaInput;
}

export type ToolChoice = "auto" | "none" | "required" | { name: string };

/**
 * Built-in web-search controls. Web search is a *server-side* tool: the
 * provider runs the searches and returns a finished answer with citations, so
 * it never round-trips through the caller like a normal `Tool`. Each adapter
 * routes this to its own native mechanism (Anthropic/OpenAI/xAI server tools,
 * Gemini grounding, Groq built-in tools) and maps only the fields it supports,
 * silently ignoring the rest; provider-specific knobs go through
 * `providerOptions`. Requesting web search on a model that cannot do it raises
 * `invalid_request`.
 */
export interface WebSearchOptions {
  /** Cap on searches per turn. Anthropic only; others ignore. */
  maxUses?: number;
  /** Restrict results to these domains (no scheme). Anthropic/OpenAI/xAI (xAI ≤5). */
  allowedDomains?: string[];
  /** Exclude these domains (no scheme). Anthropic/OpenAI/xAI (xAI ≤5). */
  blockedDomains?: string[];
  /** Approximate user location to localize results. Anthropic/OpenAI. */
  userLocation?: {
    /** Two-letter ISO country code (e.g. `US`). */
    country?: string;
    city?: string;
    region?: string;
    /** IANA timezone (e.g. `America/New_York`). */
    timezone?: string;
  };
  /** How much search context to feed the model. OpenAI only; others ignore. */
  contextSize?: "low" | "medium" | "high";
}

/** A web source the model cited. The lowest common denominator across providers. */
export interface WebCitation {
  url: string;
  title?: string;
  /** The quoted span the citation backs, when the provider exposes one. */
  snippet?: string;
}

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface RetryOptions {
  /** Number of retries after the initial attempt. Default 2. */
  maxRetries: number;
  /** Base delay for exponential backoff. Default 1000. */
  initialDelayMs: number;
  /** Backoff ceiling. Default 30000. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxRetries: 2,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
};

export interface GenerateOptions<S extends SchemaInput = SchemaInput> {
  /** Model name without provider prefix (adapters), e.g. `claude-opus-4-8`. */
  model: string;
  messages: Message[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  /**
   * Enable the provider's built-in web search. `true` uses defaults; pass a
   * {@link WebSearchOptions} object to tune it. Server-side — the provider
   * runs the searches and returns citations on the result.
   */
  webSearch?: boolean | WebSearchOptions;
  /** Structured output: constrain the response to a JSON schema. */
  output?: { schema: S };
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  /**
   * Reasoning/thinking control; adapters map to provider parameters.
   * Enabled whenever this object is present unless `enabled: false`; passing
   * `effort` implies `enabled: true`, and `enabled: true` without `effort`
   * enables at the provider's default effort.
   */
  reasoning?: { enabled?: boolean; effort?: ReasoningEffort };
  /**
   * Run the request in the provider's background mode (OpenAI / xAI Responses
   * only; ignored by other adapters). `undefined` (default) auto-enables it
   * for high-effort reasoning (`high`/`xhigh`/`max`), where long generations
   * risk idle-connection drops; `true`/`false` force it on/off. Background
   * decouples execution from the HTTP connection (and forces `store: true`):
   * `generate` creates the response then polls it to completion, `stream`
   * resumes a dropped SSE via `starting_after` instead of failing.
   */
  background?: boolean;
  /**
   * Provider-specific request fields, shallow-merged into the outgoing
   * request body last (escape hatch; overrides adapter defaults).
   */
  providerOptions?: Record<string, unknown>;
  /**
   * Per-attempt timeout in milliseconds; `undefined`/`0` (default) means no
   * timeout. Applies to each HTTP attempt (retries reset it) and bounds the
   * wait until the response begins (headers arrive). For non-streaming
   * `generate` the server only responds once generation finishes, so this
   * effectively caps total generation time; for `stream` it bounds connection
   * setup only (bound a mid-stream stall with `signal`). For a hard ceiling
   * across retries, pass `signal: AbortSignal.timeout(ms)`.
   */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Override retry behavior; `false` disables retries. */
  retry?: Partial<RetryOptions> | false;
}

export interface GenerateResult<T = unknown> {
  /** Assistant message (text / thinking / tool_call parts). */
  message: Message;
  finishReason: FinishReason;
  usage: Usage;
  /**
   * The assistant reply's visible text: its `text` parts joined with "\n",
   * excluding thinking and tool calls. Convenience over walking
   * `message.content`; empty string when the turn produced no text.
   */
  text: string;
  /** Parsed (and zod-validated, if applicable) structured output. */
  output?: T;
  /** Web-search sources the model cited, if web search ran. */
  citations?: WebCitation[];
  /** Raw provider response body, for debugging/forward-compat. */
  raw: unknown;
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

export interface EmbedOptions {
  model: string;
  input: string[];
  providerOptions?: Record<string, unknown>;
  /** Per-attempt timeout (ms); `undefined`/`0` (default) means none. See {@link GenerateOptions.timeoutMs}. */
  timeoutMs?: number;
  signal?: AbortSignal;
  retry?: Partial<RetryOptions> | false;
}

export interface EmbedResult {
  embeddings: number[][];
  usage: Usage;
  raw: unknown;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface Provider {
  readonly name: string;
  generate(options: GenerateOptions): Promise<GenerateResult>;
  stream(options: GenerateOptions): AsyncIterable<StreamEvent>;
  /** Only providers that offer embeddings implement this. */
  embed?(options: EmbedOptions): Promise<EmbedResult>;
}
