import {
  CardanError,
  codeFromStatus,
  parseRetryAfter,
  wrapFetchError,
  type ErrorCode,
} from "../errors.js";
import { readEnv } from "../env.js";
import { normalizeMessages, partsToText } from "../normalize.js";
import { parseSse } from "../sse.js";
import { resolveRetry, withRetry } from "../retry.js";
import { toJsonSchema } from "../schema.js";
import {
  bytesToBase64,
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
} from "../types.js";

/** Models are whatever the caller deployed; there is no known-model list. */
export type ModalModel = string;

export interface ModalProviderOptions {
  /**
   * Deployment URL (e.g. `https://workspace--app-serve.modal.run`). Required —
   * every Modal deployment has its own URL. Defaults to the `MODAL_BASE_URL`
   * environment variable.
   */
  baseUrl?: string;
  /**
   * Bearer token for servers started with an API key (vLLM `--api-key`,
   * SGLang `--api-key`). Defaults to the `MODAL_API_KEY` environment
   * variable. Optional — endpoints may be unauthenticated.
   */
  apiKey?: string;
  /**
   * Modal Proxy Auth Token, sent as the `Modal-Key` / `Modal-Secret` headers
   * for endpoints deployed with `requires_proxy_auth=True`. Defaults to the
   * `MODAL_KEY` / `MODAL_SECRET` environment variables (cardan's convention,
   * named after the headers). Optional.
   */
  proxyAuth?: { tokenId: string; tokenSecret: string };
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  /** Custom fetch implementation (testing, proxies). */
  fetch?: typeof globalThis.fetch;
  /** Default retry behavior for all requests; `false` disables. */
  retry?: Partial<RetryOptions> | false;
}

/** Chat Completions `reasoning_effort` tops out at `high`. */
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

interface ChatResponseBody {
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: ChatToolCall[];
    };
    finish_reason?: string | null;
  }>;
  usage?: ChatUsage;
  error?: { message?: string; code?: unknown } | null;
}

interface ChatStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<ChatToolCall & { index?: number }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: ChatUsage | null;
  error?: { message?: string } | null;
}

/**
 * Modal adapter for self-deployed models behind Modal web endpoints. Modal's
 * documented LLM serving pattern wraps vLLM/SGLang with `@modal.web_server`,
 * exposing the **Chat Completions** API (`/v1/chat/completions`) — not the
 * Responses API — so this adapter speaks Chat Completions, including the
 * `reasoning_content` extension both servers use for reasoning models.
 *
 * Capability notes:
 * - `baseUrl` is required (each deployment has its own `*.modal.run` URL);
 * - both auth schemes are optional and may be combined: `apiKey` becomes an
 *   `Authorization: Bearer` header (vLLM/SGLang `--api-key`), `proxyAuth`
 *   becomes `Modal-Key`/`Modal-Secret` headers (Modal Proxy Auth Tokens);
 * - thinking parts are not replayable in Chat Completions and are dropped
 *   when converting messages; responses map `reasoning_content` to a
 *   thinking part (no signature, so it never replays anywhere);
 * - `reasoning.effort` maps to `reasoning_effort` (`xhigh`/`max` cap to
 *   `high`); servers/models without support reject it — omit `reasoning`
 *   then. `reasoning.enabled` has no generic Chat Completions mapping and is
 *   ignored; use `providerOptions` for model-specific switches (e.g.
 *   `chat_template_kwargs: { enable_thinking: false }` on vLLM);
 * - sends `max_tokens` (not `max_completion_tokens`) for maximal
 *   compatibility with self-hosted servers;
 * - streaming requests `stream_options: { include_usage: true }`; servers
 *   that ignore it yield zero usage;
 * - `embed` targets `/v1/embeddings` and only works if the deployment serves
 *   an embedding model.
 */
export class ModalProvider implements Provider {
  readonly name: string = "modal";
  private readonly options: ModalProviderOptions;
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: ModalProviderOptions = {}) {
    this.options = options;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const body = await this.buildRequestBody(options, false);
    const retry = resolveRetry(options.retry ?? this.options.retry);
    const response = await withRetry(
      () => this.request("/v1/chat/completions", body, options.signal),
      retry,
      options.signal,
    );
    const raw = (await response.json()) as ChatResponseBody;
    return this.parseResponse(raw, options);
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamEvent> {
    const body = await this.buildRequestBody(options, true);
    const retry = resolveRetry(options.retry ?? this.options.retry);
    const response = await withRetry(
      () => this.request("/v1/chat/completions", body, options.signal),
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

  async embed(options: EmbedOptions): Promise<EmbedResult> {
    const body: Record<string, unknown> = {
      model: options.model,
      input: options.input,
    };
    if (options.providerOptions) Object.assign(body, options.providerOptions);
    const retry = resolveRetry(options.retry ?? this.options.retry);
    const response = await withRetry(
      () => this.request("/v1/embeddings", body, options.signal),
      retry,
      options.signal,
    );
    const raw = (await response.json()) as {
      data?: Array<{ index?: number; embedding?: number[] }>;
      usage?: { prompt_tokens?: number };
    };
    const data = [...(raw.data ?? [])].sort(
      (a, b) => (a.index ?? 0) - (b.index ?? 0),
    );
    const usage = emptyUsage();
    usage.input.total = raw.usage?.prompt_tokens ?? 0;
    return { embeddings: data.map((item) => item.embedding ?? []), usage, raw };
  }

  // -------------------------------------------------------------------------
  // Request
  // -------------------------------------------------------------------------

  private baseUrl(): string {
    const url = this.options.baseUrl ?? readEnv("MODAL_BASE_URL");
    if (!url) {
      throw new CardanError(
        "invalid_request",
        "missing Modal deployment URL: pass `baseUrl` or set MODAL_BASE_URL",
        { provider: this.name },
      );
    }
    return url.replace(/\/+$/, "");
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    const apiKey = this.options.apiKey ?? readEnv("MODAL_API_KEY");
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const tokenId = this.options.proxyAuth?.tokenId ?? readEnv("MODAL_KEY");
    const tokenSecret =
      this.options.proxyAuth?.tokenSecret ?? readEnv("MODAL_SECRET");
    if (Boolean(tokenId) !== Boolean(tokenSecret)) {
      throw new CardanError(
        "auth",
        "Modal proxy auth requires both the token id (MODAL_KEY) and secret (MODAL_SECRET)",
        { provider: this.name },
      );
    }
    if (tokenId && tokenSecret) {
      headers["Modal-Key"] = tokenId;
      headers["Modal-Secret"] = tokenSecret;
    }
    return headers;
  }

  private async request(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const url = `${this.baseUrl()}${path}`;
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.authHeaders(),
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
      const text = await response.text();
      try {
        raw = JSON.parse(text);
        const error = (raw as { error?: { message?: string } }).error;
        if (error?.message) message = error.message;
        else {
          // vLLM error bodies are sometimes flat: { message, type, code }
          const flat = (raw as { message?: unknown }).message;
          if (typeof flat === "string" && flat) message = flat;
        }
      } catch {
        // Modal proxy-auth failures return plain text ("modal-http: …")
        raw = text;
        if (text) message = text.slice(0, 200);
      }
    } catch {
      // keep generic message; body was unreadable
    }
    let code: ErrorCode = codeFromStatus(response.status);
    if (
      code === "invalid_request" &&
      /context (window|length)|maximum context|too many tokens/i.test(message)
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
    if (options.webSearch) {
      throw new CardanError(
        "invalid_request",
        "Modal deployments have no built-in web search",
        { provider: this.name },
      );
    }
    const body: Record<string, unknown> = {
      model: options.model,
      messages: convertMessages(normalizeMessages(options.messages)),
    };
    if (stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    if (options.maxOutputTokens !== undefined) {
      // max_tokens, not max_completion_tokens: self-hosted servers all accept
      // the former; only newer ones know the latter
      body.max_tokens = options.maxOutputTokens;
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
          strict: true,
          schema: await toJsonSchema(options.output.schema),
        },
      };
    }
    if (options.reasoning?.effort && options.reasoning.enabled !== false) {
      body.reasoning_effort = EFFORT_MAP[options.reasoning.effort];
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
    if (message?.reasoning_content) {
      content.push({ type: "thinking", text: message.reasoning_content });
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
      finishReason: mapFinishReason(choice?.finish_reason),
      usage: mapUsage(raw.usage ?? undefined),
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
    // tool call fragments accumulate per index until the choice finishes
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: FinishReason = "other";
    let sawFinish = false;
    let usage = emptyUsage();

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
        yield { type: "finish", reason: finishReason, usage };
        return;
      }
      let chunk: ChatStreamChunk;
      try {
        chunk = JSON.parse(data) as ChatStreamChunk;
      } catch {
        continue;
      }
      if (chunk.error) {
        throw new CardanError(
          "server",
          chunk.error.message ?? "stream error",
          { provider: this.name, raw: chunk, retryable: false },
        );
      }
      if (chunk.usage) usage = mapUsage(chunk.usage);
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (delta.reasoning_content) {
        yield { type: "thinking_delta", text: delta.reasoning_content };
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
        // id/name arrive complete in the first fragment (and may be resent
        // verbatim); only arguments stream as appendable pieces
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
    // self-hosted servers may close the stream after the final chunk without a
    // [DONE] sentinel; once finish_reason is seen the response is complete, so
    // emit finish rather than treat it as a cut connection
    if (sawFinish) {
      yield { type: "finish", reason: finishReason, usage };
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
 * Converts generic messages to Chat Completions messages. System messages
 * stay in place (vLLM/SGLang accept them anywhere); thinking parts are
 * dropped (Chat Completions has no reasoning replay format); tool results
 * become one `tool` message each.
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
        // plain string when text-only, for maximal server compatibility
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

