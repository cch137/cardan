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
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  /** Emitted when a thinking block closes with a replay signature. */
  | { type: "thinking_signature"; signature: string; id?: string }
  /** Emitted once per tool call, when its arguments are complete. */
  | { type: "tool_call"; id: string; name: string; args: unknown; signature?: string }
  | { type: "finish"; reason: FinishReason; usage: Usage };

export interface Tool {
  name: string;
  description?: string;
  /** JSON Schema object or zod schema describing the arguments. */
  parameters?: SchemaInput;
}

export type ToolChoice = "auto" | "none" | "required" | { name: string };

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

export interface GenerateOptions {
  /** Model name without provider prefix (adapters), e.g. `claude-opus-4-8`. */
  model: string;
  messages: Message[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  /** Structured output: constrain the response to a JSON schema. */
  output?: { schema: SchemaInput };
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
   * Provider-specific request fields, shallow-merged into the outgoing
   * request body last (escape hatch; overrides adapter defaults).
   */
  providerOptions?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Override retry behavior; `false` disables retries. */
  retry?: Partial<RetryOptions> | false;
}

export interface GenerateResult {
  /** Assistant message (text / thinking / tool_call parts). */
  message: Message;
  finishReason: FinishReason;
  usage: Usage;
  /** Parsed (and zod-validated, if applicable) structured output. */
  output?: unknown;
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
