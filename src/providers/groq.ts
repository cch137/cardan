import {
  CardanError,
  codeFromStatus,
  parseRetryAfter,
  streamCardanError,
  wrapFetchError,
  type ErrorCode,
} from "../errors.js";
import { readEnv } from "../env.js";
import { normalizeMessages, partsToText } from "../normalize.js";
import { parseSse } from "../sse.js";
import { resolveRetry, resolveTimeout, withRetry, withTimeoutSignal } from "../retry.js";
import { toJsonSchema } from "../schema.js";
import {
  addCitations,
  bytesToBase64,
  normalizeWebSearch,
  parseStructuredOutput,
  parseToolArgs,
  syntheticCallId,
} from "../util.js";
import {
  emptyUsage,
  type ContentPart,
  type EmbedOptions,
  type EmbedResult,
  type FinishReason,
  type GenerateOptions,
  type GenerateResult,
  type Message,
  type Provider,
  type ReasoningEffort,
  type RetryOptions,
  type StreamEvent,
  type Usage,
  type WebCitation,
} from "../types.js";

/** Known Groq model ids — literal-only, drives editor autocomplete. */
export type GroqModelId =
  | "openai/gpt-oss-120b"
  | "openai/gpt-oss-20b"
  | "openai/gpt-oss-safeguard-20b"
  | "qwen/qwen3-32b"
  | "llama-3.3-70b-versatile"
  | "llama-3.1-8b-instant"
  | "meta-llama/llama-4-scout-17b-16e-instruct"
  | "groq/compound"
  | "groq/compound-mini";

export type GroqModel = GroqModelId | (string & {});

export interface GroqProviderOptions {
  /** Defaults to the `GROQ_API_KEY` environment variable. */
  apiKey?: string;
  /** Defaults to `https://api.groq.com/openai`. */
  baseUrl?: string;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  /** Custom fetch implementation (testing, proxies). */
  fetch?: typeof globalThis.fetch;
  /** Default retry behavior for all requests; `false` disables. */
  retry?: Partial<RetryOptions> | false;
  /** Default per-attempt timeout (ms) for all requests; `0`/undefined disables. */
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://api.groq.com/openai";

/**
 * Models whose reasoning is controllable via `reasoning_format` /
 * `reasoning_effort`. Other models reject those parameters outright.
 */
const REASONING_MODELS = /gpt-oss|qwen/i;

/** Models that grade `reasoning_effort` `none`/`default` only (qwen3). */
const TOGGLE_ONLY_REASONING = /qwen/i;

/** Models supporting `strict: true` structured outputs (constrained decoding). */
const STRICT_OUTPUT_MODELS = /gpt-oss/i;

/** Reasoning models exposing the built-in `browser_search` tool. */
const BROWSER_SEARCH_MODELS = /gpt-oss/i;

/** Compound systems that run web search automatically (no tool to declare). */
const COMPOUND_MODELS = /^(?:groq\/)?compound/i;

/** Groq's graded `reasoning_effort` (gpt-oss) tops out at `high`. */
const EFFORT_MAP: Record<ReasoningEffort, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

interface ChatToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatUsage {
  prompt_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}

interface GroqMessage {
  content?: string | null;
  reasoning?: string | null;
  tool_calls?: ChatToolCall[];
  /** Compound systems: per-tool execution records, may carry search results. */
  executed_tools?: unknown[];
  /** Some shapes attach search hits directly on the message. */
  search_results?: unknown;
}

interface ChatResponseBody {
  choices?: Array<{
    message?: GroqMessage;
    finish_reason?: string | null;
  }>;
  usage?: ChatUsage;
  error?: { message?: string; code?: unknown } | null;
}

interface ChatStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<ChatToolCall & { index?: number }>;
    };
    message?: GroqMessage;
    finish_reason?: string | null;
  }>;
  usage?: ChatUsage | null;
  x_groq?: { usage?: ChatUsage; executed_tools?: unknown[] } | null;
  error?: { message?: string } | null;
}

/**
 * Groq adapter built on the **Chat Completions** API
 * (`/openai/v1/chat/completions`) — Groq's stable primary interface. Groq's
 * Responses API is beta and rejects `store`/`include`, so the stateless
 * Responses design used for OpenAI/xAI does not transfer.
 *
 * Capability notes:
 * - reasoning models (gpt-oss, qwen3) always get `reasoning_format: "parsed"`
 *   so thinking lands in `message.reasoning` (mapped to a thinking part)
 *   instead of `<think>` tags in the text, and tool use / JSON mode stay
 *   valid. Thinking parts carry no signature and are dropped on replay
 *   (Chat Completions has no reasoning replay format);
 * - `reasoning.effort` maps to `reasoning_effort`: gpt-oss grades
 *   `low`/`medium`/`high` (`xhigh`/`max` cap to `high`); qwen3 only knows
 *   `none`/`default`, so graded efforts are omitted there.
 *   `reasoning.enabled: false` maps to `"none"`, which only qwen3 accepts —
 *   gpt-oss cannot disable reasoning. Omit `reasoning` entirely for
 *   non-reasoning models (Groq rejects the parameters);
 * - structured output sends `response_format.json_schema`; `strict: true`
 *   (constrained decoding) only where supported (gpt-oss), other models get
 *   best-effort mode — zod schemas still validate client-side either way.
 *   Models without json_schema support (e.g. llama-3.x) reject the request;
 * - prompt caching is automatic; cache hits surface as
 *   `usage.input.details.cache_read`;
 * - Groq offers no embeddings API; `embed` throws `invalid_request`.
 */
export class GroqProvider implements Provider {
  readonly name: string = "groq";
  private readonly options: GroqProviderOptions;
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: GroqProviderOptions = {}) {
    this.options = options;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const body = await this.buildRequestBody(options, false);
    const retry = resolveRetry(options.retry ?? this.options.retry);
    const timeoutMs = resolveTimeout(options.timeoutMs, this.options.timeoutMs);
    const response = await withRetry(
      () => this.request("/v1/chat/completions", body, options.signal, timeoutMs),
      retry,
      options.signal,
    );
    const raw = (await response.json()) as ChatResponseBody;
    return this.parseResponse(raw, options);
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamEvent> {
    const body = await this.buildRequestBody(options, true);
    const retry = resolveRetry(options.retry ?? this.options.retry);
    const timeoutMs = resolveTimeout(options.timeoutMs, this.options.timeoutMs);
    const response = await withRetry(
      () => this.request("/v1/chat/completions", body, options.signal, timeoutMs),
      retry,
      options.signal,
    );
    if (!response.body) {
      throw new CardanError("network", "response has no body", {
        provider: this.name,
      });
    }
    yield* this.parseStream(response.body);
  }

  embed(_options: EmbedOptions): Promise<EmbedResult> {
    return Promise.reject(
      new CardanError("invalid_request", "Groq does not offer an embeddings API", {
        provider: this.name,
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Request
  // -------------------------------------------------------------------------

  private apiKey(): string {
    const key = this.options.apiKey ?? readEnv("GROQ_API_KEY");
    if (!key) {
      throw new CardanError(
        "auth",
        "missing groq API key: pass `apiKey` or set GROQ_API_KEY",
        { provider: this.name },
      );
    }
    return key;
  }

  private async request(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<Response> {
    const url = `${this.options.baseUrl ?? DEFAULT_BASE_URL}${path}`;
    const { signal: composed, clear } = withTimeoutSignal(signal, timeoutMs);
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey()}`,
          ...this.options.headers,
        },
        body: JSON.stringify(body),
        signal: composed ?? null,
      });
    } catch (error) {
      throw wrapFetchError(error, this.name);
    } finally {
      clear();
    }
    if (!response.ok) {
      throw await this.httpError(response);
    }
    return response;
  }

  private async httpError(response: Response): Promise<CardanError> {
    let raw: unknown;
    let message = `HTTP ${response.status}`;
    try {
      raw = await response.json();
      const error = (raw as { error?: { message?: string } }).error;
      if (error?.message) message = error.message;
    } catch {
      // keep generic message; body was not JSON
    }
    let code: ErrorCode = codeFromStatus(response.status);
    // Groq reports oversized prompts as 413 request_too_large
    if (
      response.status === 413 ||
      (code === "invalid_request" &&
        /context (window|length)|too many tokens|reduce the length/i.test(message))
    ) {
      code = "context_length";
    }
    return new CardanError(code, message, {
      provider: this.name,
      status: response.status,
      retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      raw,
    });
  }

  private async buildRequestBody(
    options: GenerateOptions,
    stream: boolean,
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: convertMessages(normalizeMessages(options.messages)),
    };
    if (stream) body.stream = true;
    if (options.maxOutputTokens !== undefined) {
      body.max_completion_tokens = options.maxOutputTokens;
    }
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.topP !== undefined) body.top_p = options.topP;
    if (options.stopSequences?.length) body.stop = options.stopSequences;

    if (options.tools?.length) {
      body.tools = await Promise.all(
        options.tools.map(async (tool) => ({
          type: "function",
          function: {
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            parameters: tool.parameters
              ? await toJsonSchema(tool.parameters)
              : { type: "object", properties: {} },
          },
        })),
      );
    }
    if (options.toolChoice !== undefined) {
      body.tool_choice = convertToolChoice(options.toolChoice);
    }
    if (options.output) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: "output",
          // constrained decoding where supported; everything else is
          // best-effort (zod schemas still validate client-side)
          ...(STRICT_OUTPUT_MODELS.test(options.model) ? { strict: true } : {}),
          schema: await toJsonSchema(options.output.schema),
        },
      };
    }
    if (REASONING_MODELS.test(options.model)) {
      // parsed keeps thinking out of the text content and is the only format
      // (besides hidden) valid alongside tool use / JSON mode
      body.reasoning_format = "parsed";
    }
    if (options.reasoning) {
      const effort = convertReasoningEffort(options.model, options.reasoning);
      if (effort) body.reasoning_effort = effort;
    }

    if (normalizeWebSearch(options.webSearch)) {
      const browser = BROWSER_SEARCH_MODELS.test(options.model);
      const compound = COMPOUND_MODELS.test(options.model);
      if (!browser && !compound) {
        throw new CardanError(
          "invalid_request",
          `model "${options.model}" does not support web search`,
          { provider: this.name },
        );
      }
      if (browser) {
        if (options.output) {
          throw new CardanError(
            "invalid_request",
            "Groq browser search is incompatible with structured output",
            { provider: this.name },
          );
        }
        // reasoning models declare the built-in tool explicitly; domain/location
        // knobs aren't supported, so WebSearchOptions fields are ignored
        const tools = (body.tools as Array<Record<string, unknown>>) ?? [];
        tools.push({ type: "browser_search" });
        body.tools = tools;
      }
      // compound systems run web search automatically; nothing to declare
    }

    if (options.providerOptions) Object.assign(body, options.providerOptions);
    return body;
  }

  // -------------------------------------------------------------------------
  // Response
  // -------------------------------------------------------------------------

  private parseResponse(
    raw: ChatResponseBody,
    options: GenerateOptions,
  ): GenerateResult {
    if (raw.error) {
      throw new CardanError("unknown", raw.error.message ?? "request failed", {
        provider: this.name,
        raw,
        retryable: false,
      });
    }
    const choice = raw.choices?.[0];
    const message = choice?.message;
    const content: ContentPart[] = [];
    if (message?.reasoning) {
      content.push({ type: "thinking", text: message.reasoning });
    }
    if (message?.content) {
      content.push({ type: "text", text: message.content });
    }
    for (const call of message?.tool_calls ?? []) {
      content.push({
        type: "tool_call",
        id: call.id || syntheticCallId(),
        name: String(call.function?.name ?? ""),
        args: parseToolArgs(String(call.function?.arguments ?? ""), this.name),
      });
    }
    const result: GenerateResult = {
      message: { role: "assistant", content },
      text: partsToText(content),
      finishReason: mapFinishReason(choice?.finish_reason),
      usage: mapUsage(raw.usage ?? undefined),
      raw,
    };
    const citations: WebCitation[] = [];
    if (message) extractGroqCitations(message, citations);
    if (citations.length) result.citations = citations;
    if (options.output && result.finishReason !== "refusal") {
      result.output = parseStructuredOutput(
        content,
        options.output.schema,
        this.name,
      );
    }
    return result;
  }

  private async *parseStream(
    body: ReadableStream<Uint8Array>,
  ): AsyncGenerator<StreamEvent> {
    // tool call fragments accumulate per index until the choice finishes
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: FinishReason = "other";
    let sawFinish = false;
    let usage = emptyUsage();
    const citations: WebCitation[] = [];

    const flushCalls = function* (provider: string): Generator<StreamEvent> {
      for (const [, call] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
        yield {
          type: "tool_call",
          id: call.id || syntheticCallId(),
          name: call.name,
          args: parseToolArgs(call.args, provider),
        };
      }
      pending.clear();
    };

    for await (const { data } of parseSse(body)) {
      if (data.trim() === "[DONE]") {
        yield* flushCalls(this.name);
        yield {
          type: "finish",
          reason: finishReason,
          usage,
          ...(citations.length ? { citations } : {}),
        };
        return;
      }
      let chunk: ChatStreamChunk;
      try {
        chunk = JSON.parse(data) as ChatStreamChunk;
      } catch {
        continue;
      }
      if (chunk.error) {
        throw streamCardanError(chunk, this.name);
      }
      // the finish_reason chunk carries usage (top-level and under x_groq)
      const chunkUsage = chunk.usage ?? chunk.x_groq?.usage;
      if (chunkUsage) usage = mapUsage(chunkUsage);
      // compound systems surface search results on the final chunk's message
      // or x_groq block; best-effort, shapes vary by system
      if (chunk.x_groq?.executed_tools) {
        collectFromExecutedTools(chunk.x_groq.executed_tools, citations);
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.message) extractGroqCitations(choice.message, citations);
      const delta = choice.delta ?? {};
      if (delta.reasoning) {
        yield { type: "thinking_delta", text: delta.reasoning };
      }
      if (delta.content) {
        yield { type: "text_delta", text: delta.content };
      }
      for (const fragment of delta.tool_calls ?? []) {
        const index = fragment.index ?? 0;
        let call = pending.get(index);
        if (!call) {
          call = { id: "", name: "", args: "" };
          pending.set(index, call);
        }
        // id/name arrive complete in the first fragment; only arguments
        // stream as appendable pieces
        if (fragment.id && !call.id) call.id = fragment.id;
        if (fragment.function?.name && !call.name) {
          call.name = fragment.function.name;
        }
        if (fragment.function?.arguments) {
          call.args += fragment.function.arguments;
        }
      }
      if (choice.finish_reason) {
        finishReason = mapFinishReason(choice.finish_reason);
        sawFinish = true;
        yield* flushCalls(this.name);
      }
    }
    // some OpenAI-compatible servers close the stream after the final chunk
    // without a [DONE] sentinel; once finish_reason is seen the response is
    // complete, so emit finish rather than treat it as a cut connection
    if (sawFinish) {
      yield {
        type: "finish",
        reason: finishReason,
        usage,
        ...(citations.length ? { citations } : {}),
      };
      return;
    }
    throw new CardanError("network", "stream ended unexpectedly", {
      provider: this.name,
    });
  }
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/**
 * Best-effort extraction of cited sources from a Groq message. Compound
 * systems expose them under `executed_tools[].search_results.results` or a
 * message-level `search_results.results`; gpt-oss `browser_search` keeps
 * citations inline in the text (no structured URLs), so those stay in `raw`.
 */
function extractGroqCitations(message: GroqMessage, out: WebCitation[]): void {
  collectFromSearchResults(message.search_results, out);
  if (Array.isArray(message.executed_tools)) {
    collectFromExecutedTools(message.executed_tools, out);
  }
}

function collectFromExecutedTools(tools: unknown[], out: WebCitation[]): void {
  for (const tool of tools) {
    if (tool && typeof tool === "object") {
      collectFromSearchResults(
        (tool as { search_results?: unknown }).search_results,
        out,
      );
    }
  }
}

function collectFromSearchResults(searchResults: unknown, out: WebCitation[]): void {
  const results = (searchResults as { results?: unknown })?.results;
  if (!Array.isArray(results)) return;
  for (const item of results) {
    if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      if (obj.url) {
        addCitations(out, [
          {
            url: String(obj.url),
            ...(obj.title ? { title: String(obj.title) } : {}),
            ...(obj.content ? { snippet: String(obj.content) } : {}),
          },
        ]);
      }
    }
  }
}

function convertReasoningEffort(
  model: string,
  reasoning: NonNullable<GenerateOptions["reasoning"]>,
): string | undefined {
  // non-reasoning models reject reasoning_effort outright (even "none"), so
  // never send it for them — including when the caller asks to disable
  if (!REASONING_MODELS.test(model)) return undefined;
  // `none` is only accepted by qwen3; gpt-oss cannot disable reasoning and
  // rejects it with a clear API error
  if (reasoning.enabled === false) return "none";
  if (!reasoning.effort) return undefined;
  // qwen3 accepts only none/default — graded efforts would be rejected
  if (TOGGLE_ONLY_REASONING.test(model)) return undefined;
  return EFFORT_MAP[reasoning.effort];
}

/**
 * Converts generic messages to Chat Completions messages. System messages
 * stay in place; thinking parts are dropped (Chat Completions has no
 * reasoning replay format); tool results become one `tool` message each.
 */
function convertMessages(messages: Message[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    switch (message.role) {
      case "system":
        out.push({ role: "system", content: partsToText(message.content) });
        break;
      case "user": {
        const parts = message.content
          .map(convertUserPart)
          .filter((part): part is Record<string, unknown> => part !== null);
        if (parts.length === 0) break;
        // plain string when text-only; array content is only accepted by
        // vision models
        const allText = parts.every((part) => part.type === "text");
        out.push({
          role: "user",
          content: allText
            ? parts.map((part) => String(part.text)).join("\n")
            : parts,
        });
        break;
      }
      case "assistant": {
        const texts: string[] = [];
        const toolCalls: Array<Record<string, unknown>> = [];
        for (const part of message.content) {
          if (part.type === "text") {
            texts.push(part.text);
          } else if (part.type === "tool_call") {
            toolCalls.push({
              id: part.id,
              type: "function",
              function: {
                name: part.name,
                arguments: JSON.stringify(part.args ?? {}),
              },
            });
          }
          // thinking: not replayable in Chat Completions; images in
          // assistant turns are not representable
        }
        if (texts.length === 0 && toolCalls.length === 0) break;
        out.push({
          role: "assistant",
          content: texts.length > 0 ? texts.join("\n") : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
        break;
      }
      case "tool":
        for (const part of message.content) {
          if (part.type !== "tool_result") continue;
          out.push({
            role: "tool",
            tool_call_id: part.callId,
            content: part.isError
              ? JSON.stringify({ error: part.result })
              : typeof part.result === "string"
                ? part.result
                : JSON.stringify(part.result),
          });
        }
        break;
    }
  }
  return out;
}

function convertUserPart(part: ContentPart): Record<string, unknown> | null {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image":
      return {
        type: "image_url",
        image_url: {
          url:
            part.data instanceof URL
              ? part.data.href
              : `data:${part.mimeType};base64,${bytesToBase64(part.data)}`,
        },
      };
    default:
      return null;
  }
}

function convertToolChoice(
  choice: NonNullable<GenerateOptions["toolChoice"]>,
): unknown {
  if (choice === "auto" || choice === "none" || choice === "required")
    return choice;
  return { type: "function", function: { name: choice.name } };
}

function mapFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
      return "tool_calls";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}

function mapUsage(usage: ChatUsage | undefined): Usage {
  const result = emptyUsage();
  if (!usage) return result;
  result.input.total = usage.prompt_tokens ?? 0;
  const cached = usage.prompt_tokens_details?.cached_tokens;
  if (cached) result.input.details.cache_read = cached;
  result.output.total = usage.completion_tokens ?? 0;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  if (reasoning) result.output.details.reasoning = reasoning;
  return result;
}

