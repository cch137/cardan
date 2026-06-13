import {
  CardanError,
  codeFromStatus,
  parseRetryAfter,
  wrapFetchError,
  type ErrorCode,
} from "../errors.js";
import { readEnv } from "../env.js";
import { normalizeMessages, splitLeadingSystem } from "../normalize.js";
import { parseSse } from "../sse.js";
import { resolveRetry, withRetry } from "../retry.js";
import { toJsonSchema } from "../schema.js";
import {
  addCitations,
  bytesToBase64,
  normalizeWebSearch,
  parseStructuredOutput,
  parseToolArgs,
} from "../util.js";
import {
  emptyUsage,
  type ContentPart,
  type FinishReason,
  type GenerateOptions,
  type GenerateResult,
  type Message,
  type Provider,
  type RetryOptions,
  type StreamEvent,
  type Usage,
  type WebCitation,
  type WebSearchOptions,
} from "../types.js";

export type AnthropicModel =
  | "claude-fable-5"
  | "claude-opus-4-8"
  | "claude-opus-4-7"
  | "claude-opus-4-6"
  | "claude-opus-4-5"
  | "claude-sonnet-4-6"
  | "claude-sonnet-4-5"
  | "claude-haiku-4-5"
  | (string & {});

export interface AnthropicProviderOptions {
  /** Defaults to the `ANTHROPIC_API_KEY` environment variable. */
  apiKey?: string;
  /** Defaults to `https://api.anthropic.com`. */
  baseUrl?: string;
  /** `anthropic-version` header. Defaults to `2023-06-01`. */
  version?: string;
  /** Extra headers on every request (e.g. `anthropic-beta`). */
  headers?: Record<string, string>;
  /** Custom fetch implementation (testing, proxies). */
  fetch?: typeof globalThis.fetch;
  /** Default retry behavior for all requests; `false` disables. */
  retry?: Partial<RetryOptions> | false;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_VERSION = "2023-06-01";
const DEFAULT_MAX_OUTPUT_TOKENS = 16000;

/**
 * Models that reject sampling parameters (`temperature`, `top_p`); the
 * adapter drops them instead of failing the request.
 */
const NO_SAMPLING_PARAMS = /^claude-(fable|mythos)-5|^claude-opus-4-(7|8)/;

/** GA server-side web-search tool. Same result/citation wire shape as later versions. */
const WEB_SEARCH_TOOL_VERSION = "web_search_20250305";

/** Models with the server-side web-search tool (Claude 4+ / fable / mythos). */
const WEB_SEARCH_MODELS =
  /^claude-(?:opus|sonnet|haiku)-[4-9]|^claude-(?:fable|mythos)/;

/**
 * Bound on transparent `pause_turn` resumes. Each paused response already
 * represents a full server-side tool loop, so this caps total search rounds
 * generously while preventing an unbounded resume loop.
 */
const MAX_SERVER_TOOL_TURNS = 10;

interface AnthropicContentBlock {
  type: string;
  [key: string]: unknown;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  // thinking-token breakdown, if the API ever reports one separately (today
  // thinking is folded into output_tokens); defensively read both spellings
  output_tokens_details?: { thinking_tokens?: number };
  thinking_tokens?: number;
  // server-side tool invocation counts (billed per request, not in tokens)
  server_tool_use?: { web_search_requests?: number };
}

interface AnthropicMessageResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  usage?: AnthropicUsage;
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private readonly options: AnthropicProviderOptions;
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: AnthropicProviderOptions = {}) {
    this.options = options;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const body = await this.buildRequestBody(options, false);
    const retry = resolveRetry(options.retry ?? this.options.retry);
    const messages = body.messages as Array<Record<string, unknown>>;

    const content: ContentPart[] = [];
    const citations: WebCitation[] = [];
    const usage = emptyUsage();
    let finishReason: FinishReason = "other";
    let lastRaw: AnthropicMessageResponse = {};

    // server-side tools (web search) run a sampling loop server-side; when it
    // hits its iteration cap the response stops with `pause_turn`. Re-send the
    // assistant turn verbatim to resume, transparently, as one logical turn.
    for (let turn = 0; turn < MAX_SERVER_TOOL_TURNS; turn++) {
      const response = await withRetry(
        () => this.request("/v1/messages", body, options.signal),
        retry,
        options.signal,
      );
      const raw = (await response.json()) as AnthropicMessageResponse;
      lastRaw = raw;
      for (const block of raw.content ?? []) {
        const part = convertResponseBlock(block);
        if (part) content.push(part);
        extractBlockCitations(block, citations);
      }
      addUsage(usage, mapUsage(raw.usage));
      if (raw.stop_reason !== "pause_turn") {
        finishReason = mapStopReason(raw.stop_reason);
        break;
      }
      messages.push({ role: "assistant", content: raw.content ?? [] });
    }

    const result: GenerateResult = {
      message: { role: "assistant", content },
      finishReason,
      usage,
      raw: lastRaw,
    };
    if (citations.length) result.citations = citations;
    if (options.output && finishReason !== "refusal") {
      result.output = parseStructuredOutput(
        content,
        options.output.schema,
        this.name,
      );
    }
    return result;
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamEvent> {
    const body = await this.buildRequestBody(options, true);
    const retry = resolveRetry(options.retry ?? this.options.retry);
    const messages = body.messages as Array<Record<string, unknown>>;
    const usage = emptyUsage();
    const citations: WebCitation[] = [];

    for (let turn = 0; turn < MAX_SERVER_TOOL_TURNS; turn++) {
      const response = await withRetry(
        () => this.request("/v1/messages", body, options.signal),
        retry,
        options.signal,
      );
      if (!response.body) {
        throw new CardanError("network", "response has no body", {
          provider: this.name,
        });
      }
      const { stopReason, rawBlocks } = yield* this.parseStreamTurn(
        response.body,
        usage,
        citations,
      );
      if (stopReason !== "pause_turn") {
        yield {
          type: "finish",
          reason: mapStopReason(stopReason),
          usage,
          ...(citations.length ? { citations } : {}),
        };
        return;
      }
      messages.push({ role: "assistant", content: rawBlocks });
    }
    // resume budget exhausted; surface what we have rather than hang
    yield {
      type: "finish",
      reason: "other",
      usage,
      ...(citations.length ? { citations } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Request
  // -------------------------------------------------------------------------

  private apiKey(): string {
    const key = this.options.apiKey ?? readEnv("ANTHROPIC_API_KEY");
    if (!key) {
      throw new CardanError(
        "auth",
        "missing Anthropic API key: pass `apiKey` or set ANTHROPIC_API_KEY",
        { provider: this.name },
      );
    }
    return key;
  }

  private async request(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const url = `${this.options.baseUrl ?? DEFAULT_BASE_URL}${path}`;
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey(),
          "anthropic-version": this.options.version ?? DEFAULT_VERSION,
          ...this.options.headers,
        },
        body: JSON.stringify(body),
        signal: signal ?? null,
      });
    } catch (error) {
      throw wrapFetchError(error, this.name);
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
      const detail = (raw as { error?: { message?: string } }).error?.message;
      if (detail) message = detail;
    } catch {
      // keep generic message; body was not JSON
    }
    let code: ErrorCode = codeFromStatus(response.status);
    if (
      code === "invalid_request" &&
      /prompt is too long|context (length|window)/i.test(message)
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
    const { system, messages } = splitLeadingSystem(
      normalizeMessages(options.messages),
    );

    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      messages: messages.map(convertMessage),
    };
    if (system) body.system = system;
    if (stream) body.stream = true;
    if (options.stopSequences?.length)
      body.stop_sequences = options.stopSequences;

    const dropSampling = NO_SAMPLING_PARAMS.test(options.model);
    if (!dropSampling) {
      if (options.temperature !== undefined)
        body.temperature = options.temperature;
      if (options.topP !== undefined) body.top_p = options.topP;
    }

    const tools: Array<Record<string, unknown>> = [];
    if (options.tools?.length) {
      tools.push(
        ...(await Promise.all(
          options.tools.map(async (tool) => ({
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            input_schema: tool.parameters
              ? await toJsonSchema(tool.parameters)
              : { type: "object" },
          })),
        )),
      );
    }
    const webSearch = normalizeWebSearch(options.webSearch);
    if (webSearch) {
      if (!WEB_SEARCH_MODELS.test(options.model)) {
        throw new CardanError(
          "invalid_request",
          `model "${options.model}" does not support web search`,
          { provider: this.name },
        );
      }
      tools.push(buildWebSearchTool(webSearch));
    }
    if (tools.length) body.tools = tools;
    if (options.toolChoice !== undefined) {
      body.tool_choice = convertToolChoice(options.toolChoice);
    }

    const outputConfig: Record<string, unknown> = {};
    if (options.output) {
      outputConfig.format = {
        type: "json_schema",
        schema: await toJsonSchema(options.output.schema),
      };
    }
    // reasoning is on unless explicitly disabled; `effort` implies enabled
    if (options.reasoning && options.reasoning.enabled !== false) {
      body.thinking = { type: "adaptive" };
      if (options.reasoning.effort) outputConfig.effort = options.reasoning.effort;
    }
    if (Object.keys(outputConfig).length > 0) body.output_config = outputConfig;

    if (options.providerOptions) Object.assign(body, options.providerOptions);
    return body;
  }

  // -------------------------------------------------------------------------
  // Response
  // -------------------------------------------------------------------------

  /**
   * Parses one streamed response. Yields cardan events, accumulates `usage`
   * and `citations` into the passed cumulative collectors, and returns the
   * turn's stop reason plus the raw assistant content blocks — the latter so a
   * `pause_turn` can be resumed by replaying them verbatim. It does *not* emit
   * the `finish` event; the caller does, once the turn really ends.
   */
  private async *parseStreamTurn(
    body: ReadableStream<Uint8Array>,
    usage: Usage,
    citations: WebCitation[],
  ): AsyncGenerator<
    StreamEvent,
    { stopReason: string | null; rawBlocks: unknown[] }
  > {
    const perTurn = emptyUsage();
    const rawBlocks: Array<Record<string, unknown>> = [];
    let stopReason: string | null = null;
    // the currently open content block, rebuilt from deltas for verbatim resume
    let block: Record<string, unknown> | null = null;
    let jsonBuffer = "";

    for await (const { data } of parseSse(body)) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      switch (event.type) {
        case "message_start": {
          const message = event.message as AnthropicMessageResponse | undefined;
          mergeUsage(perTurn, message?.usage);
          break;
        }
        case "content_block_start": {
          const start = event.content_block as AnthropicContentBlock;
          // clone so deltas mutate our copy, not the parsed event
          block = { ...start };
          jsonBuffer = "";
          if (start.type === "redacted_thinking") {
            yield {
              type: "thinking_signature",
              signature: String(start.data ?? ""),
            };
          }
          break;
        }
        case "content_block_delta": {
          const delta = event.delta as Record<string, unknown>;
          switch (delta.type) {
            case "text_delta": {
              const text = String(delta.text ?? "");
              if (block) block.text = String(block.text ?? "") + text;
              yield { type: "text_delta", text };
              break;
            }
            case "thinking_delta": {
              const text = String(delta.thinking ?? "");
              if (block) block.thinking = String(block.thinking ?? "") + text;
              yield { type: "thinking_delta", text };
              break;
            }
            case "signature_delta":
              if (block) {
                block.signature =
                  String(block.signature ?? "") + String(delta.signature ?? "");
              }
              break;
            case "input_json_delta":
              jsonBuffer += String(delta.partial_json ?? "");
              break;
            case "citations_delta": {
              const citation = delta.citation as Record<string, unknown> | undefined;
              if (block && citation) {
                const list = (block.citations as unknown[]) ?? [];
                list.push(citation);
                block.citations = list;
              }
              break;
            }
          }
          break;
        }
        case "content_block_stop": {
          if (block) {
            if (block.type === "tool_use") {
              block.input = parseToolArgs(jsonBuffer, this.name);
              yield {
                type: "tool_call",
                id: String(block.id ?? ""),
                name: String(block.name ?? ""),
                args: block.input,
              };
            } else if (block.type === "server_tool_use") {
              block.input = parseToolArgs(jsonBuffer, this.name);
            } else if (block.type === "thinking") {
              const signature = String(block.signature ?? "");
              if (signature) yield { type: "thinking_signature", signature };
            }
            extractBlockCitations(block as AnthropicContentBlock, citations);
            rawBlocks.push(block);
            block = null;
            jsonBuffer = "";
          }
          break;
        }
        case "message_delta": {
          const delta = event.delta as
            | { stop_reason?: string | null }
            | undefined;
          if (delta?.stop_reason) stopReason = delta.stop_reason;
          mergeUsage(perTurn, event.usage as AnthropicUsage | undefined);
          break;
        }
        case "message_stop":
          addUsage(usage, perTurn);
          return { stopReason, rawBlocks };
        case "error": {
          const error = event.error as
            | { type?: string; message?: string }
            | undefined;
          throw new CardanError(
            error?.type === "overloaded_error" ? "overloaded" : "server",
            error?.message ?? "stream error",
            { provider: this.name, raw: event, retryable: false },
          );
        }
      }
    }
    // stream ended without message_stop (connection cut)
    throw new CardanError("network", "stream ended unexpectedly", {
      provider: this.name,
    });
  }
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

function buildWebSearchTool(
  options: WebSearchOptions,
): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: WEB_SEARCH_TOOL_VERSION,
    name: "web_search",
  };
  if (options.maxUses !== undefined) tool.max_uses = options.maxUses;
  if (options.allowedDomains?.length) tool.allowed_domains = options.allowedDomains;
  if (options.blockedDomains?.length) tool.blocked_domains = options.blockedDomains;
  if (options.userLocation) {
    const loc = options.userLocation;
    tool.user_location = {
      type: "approximate",
      ...(loc.city ? { city: loc.city } : {}),
      ...(loc.region ? { region: loc.region } : {}),
      ...(loc.country ? { country: loc.country } : {}),
      ...(loc.timezone ? { timezone: loc.timezone } : {}),
    };
  }
  return tool;
}

/**
 * Pulls web-search sources out of a content block: server-tool result blocks
 * carry the result list, and answer text blocks carry per-claim citations.
 */
function extractBlockCitations(
  block: AnthropicContentBlock,
  out: WebCitation[],
): void {
  if (block.type === "web_search_tool_result") {
    const items = Array.isArray(block.content) ? block.content : [];
    for (const item of items as Array<Record<string, unknown>>) {
      if (item?.type === "web_search_result" && item.url) {
        addCitations(out, [
          {
            url: String(item.url),
            ...(item.title ? { title: String(item.title) } : {}),
          },
        ]);
      }
    }
  } else if (block.type === "text" && Array.isArray(block.citations)) {
    for (const c of block.citations as Array<Record<string, unknown>>) {
      if (c?.url) {
        addCitations(out, [
          {
            url: String(c.url),
            ...(c.title ? { title: String(c.title) } : {}),
            ...(c.cited_text ? { snippet: String(c.cited_text) } : {}),
          },
        ]);
      }
    }
  }
}

/** Sums one usage tally into another (for `pause_turn` resumes billed separately). */
function addUsage(target: Usage, add: Usage): void {
  target.input.total += add.input.total;
  target.output.total += add.output.total;
  for (const [key, value] of Object.entries(add.input.details))
    target.input.details[key] = (target.input.details[key] ?? 0) + value;
  for (const [key, value] of Object.entries(add.output.details))
    target.output.details[key] = (target.output.details[key] ?? 0) + value;
}

function convertMessage(message: Message): Record<string, unknown> {
  // tool results travel in user-role messages on Anthropic
  const role = message.role === "tool" ? "user" : message.role;
  return {
    role,
    content: message.content
      .map(convertRequestPart)
      .filter((part) => part !== null),
  };
}

function convertRequestPart(part: ContentPart): Record<string, unknown> | null {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image":
      return {
        type: "image",
        source:
          part.data instanceof URL
            ? { type: "url", url: part.data.href }
            : {
                type: "base64",
                media_type: part.mimeType,
                data: bytesToBase64(part.data),
              },
      };
    case "tool_call":
      return {
        type: "tool_use",
        id: part.id,
        name: part.name,
        input: part.args,
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: part.callId,
        content:
          typeof part.result === "string"
            ? part.result
            : JSON.stringify(part.result),
        ...(part.isError ? { is_error: true } : {}),
      };
    case "thinking":
      if (part.redacted) {
        return { type: "redacted_thinking", data: part.signature ?? "" };
      }
      // unsigned thinking cannot be replayed; drop it
      if (!part.signature) return null;
      return {
        type: "thinking",
        thinking: part.text,
        signature: part.signature,
      };
  }
}

function convertToolChoice(
  choice: NonNullable<GenerateOptions["toolChoice"]>,
): Record<string, unknown> {
  if (choice === "auto") return { type: "auto" };
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  return { type: "tool", name: choice.name };
}

function convertResponseBlock(
  block: AnthropicContentBlock,
): ContentPart | null {
  switch (block.type) {
    case "text":
      return { type: "text", text: String(block.text ?? "") };
    case "thinking":
      return {
        type: "thinking",
        text: String(block.thinking ?? ""),
        ...(typeof block.signature === "string" && block.signature
          ? { signature: block.signature }
          : {}),
      };
    case "redacted_thinking":
      return {
        type: "thinking",
        text: "",
        signature: String(block.data ?? ""),
        redacted: true,
      };
    case "tool_use":
      return {
        type: "tool_call",
        id: String(block.id ?? ""),
        name: String(block.name ?? ""),
        args: block.input,
      };
    default:
      // unknown block types (server tool results, citations, …) are kept in
      // `raw` but not mapped into the generic schema
      return null;
  }
}

function mapStopReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

function mapUsage(usage: AnthropicUsage | undefined): Usage {
  const result = emptyUsage();
  mergeUsage(result, usage);
  return result;
}

function mergeUsage(target: Usage, usage: AnthropicUsage | undefined): void {
  if (!usage) return;
  const cacheRead = usage.cache_read_input_tokens;
  const cacheWrite = usage.cache_creation_input_tokens;
  if (
    usage.input_tokens !== undefined ||
    cacheRead !== undefined ||
    cacheWrite !== undefined
  ) {
    // Anthropic's input_tokens excludes cached tokens; total = sum of all three
    target.input.total =
      (usage.input_tokens ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
    if (cacheRead) target.input.details.cache_read = cacheRead;
    if (cacheWrite) target.input.details.cache_write = cacheWrite;
  }
  if (usage.output_tokens !== undefined) {
    target.output.total = usage.output_tokens;
  }
  // reasoning tokens are already counted inside output_tokens; expose the
  // breakdown in details without double-counting the total
  const reasoning =
    usage.output_tokens_details?.thinking_tokens ?? usage.thinking_tokens;
  if (reasoning !== undefined) target.output.details.reasoning = reasoning;
  // web-search count is a billed request tally, not tokens; surfaced for
  // accounting under a clearly-named key
  const searches = usage.server_tool_use?.web_search_requests;
  if (searches) target.output.details.web_search_requests = searches;
}

