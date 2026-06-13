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
  bytesToBase64,
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

interface AnthropicContentBlock {
  type: string;
  [key: string]: unknown;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
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
    const response = await withRetry(
      () => this.request("/v1/messages", body, options.signal),
      retry,
      options.signal,
    );
    const raw = (await response.json()) as AnthropicMessageResponse;
    return this.parseResponse(raw, options);
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamEvent> {
    const body = await this.buildRequestBody(options, true);
    const retry = resolveRetry(options.retry ?? this.options.retry);
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
    yield* this.parseStream(response.body);
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

    if (options.tools?.length) {
      body.tools = await Promise.all(
        options.tools.map(async (tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          input_schema: tool.parameters
            ? await toJsonSchema(tool.parameters)
            : { type: "object" },
        })),
      );
    }
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

  private parseResponse(
    raw: AnthropicMessageResponse,
    options: GenerateOptions,
  ): GenerateResult {
    const content: ContentPart[] = [];
    for (const block of raw.content ?? []) {
      const part = convertResponseBlock(block);
      if (part) content.push(part);
    }
    const result: GenerateResult = {
      message: { role: "assistant", content },
      finishReason: mapStopReason(raw.stop_reason),
      usage: mapUsage(raw.usage),
      raw,
    };
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
    const usage = emptyUsage();
    let stopReason: string | null = null;
    // state for the currently open content block
    let blockType: string | null = null;
    let toolId = "";
    let toolName = "";
    let toolJson = "";
    let thinkingSignature = "";

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
          mergeUsage(usage, message?.usage);
          break;
        }
        case "content_block_start": {
          const block = event.content_block as AnthropicContentBlock;
          blockType = block.type;
          toolJson = "";
          thinkingSignature = "";
          if (block.type === "tool_use") {
            toolId = String(block.id ?? "");
            toolName = String(block.name ?? "");
          } else if (block.type === "redacted_thinking") {
            yield {
              type: "thinking_signature",
              signature: String(block.data ?? ""),
            };
          }
          break;
        }
        case "content_block_delta": {
          const delta = event.delta as Record<string, unknown>;
          switch (delta.type) {
            case "text_delta":
              yield { type: "text_delta", text: String(delta.text ?? "") };
              break;
            case "thinking_delta":
              yield {
                type: "thinking_delta",
                text: String(delta.thinking ?? ""),
              };
              break;
            case "signature_delta":
              thinkingSignature += String(delta.signature ?? "");
              break;
            case "input_json_delta":
              toolJson += String(delta.partial_json ?? "");
              break;
          }
          break;
        }
        case "content_block_stop": {
          if (blockType === "tool_use") {
            yield {
              type: "tool_call",
              id: toolId,
              name: toolName,
              args: parseToolArgs(toolJson, this.name),
            };
          } else if (blockType === "thinking" && thinkingSignature) {
            yield { type: "thinking_signature", signature: thinkingSignature };
          }
          blockType = null;
          break;
        }
        case "message_delta": {
          const delta = event.delta as
            | { stop_reason?: string | null }
            | undefined;
          if (delta?.stop_reason) stopReason = delta.stop_reason;
          mergeUsage(usage, event.usage as AnthropicUsage | undefined);
          break;
        }
        case "message_stop":
          yield { type: "finish", reason: mapStopReason(stopReason), usage };
          return;
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
}

