import {
  CardanError,
  codeFromStatus,
  isCardanError,
  parseRetryAfter,
  wrapFetchError,
  type ErrorCode,
} from "../errors.js";
import { readEnv } from "../env.js";
import { normalizeMessages, partsToText } from "../normalize.js";
import { parseSse } from "../sse.js";
import { delay, resolveRetry, resolveTimeout, withRetry, withTimeoutSignal } from "../retry.js";
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
  type ThinkingPart,
  type Usage,
  type WebCitation,
  type WebSearchOptions,
} from "../types.js";

/** Known OpenAI model ids — literal-only, drives editor autocomplete. */
export type OpenAIModelId =
  | "gpt-5.5"
  | "gpt-5.5-pro"
  | "gpt-5.4"
  | "gpt-5.4-mini"
  | "gpt-5.4-nano"
  | "gpt-5.3-codex"
  | "o3"
  | "o4-mini"
  | "text-embedding-3-small"
  | "text-embedding-3-large";

export type OpenAIModel = OpenAIModelId | (string & {});

export interface OpenAIProviderOptions {
  /** Defaults to the `OPENAI_API_KEY` environment variable. */
  apiKey?: string;
  /** Defaults to `https://api.openai.com`. */
  baseUrl?: string;
  /** Extra headers on every request (e.g. `OpenAI-Organization`). */
  headers?: Record<string, string>;
  /** Custom fetch implementation (testing, proxies). */
  fetch?: typeof globalThis.fetch;
  /** Default retry behavior for all requests; `false` disables. */
  retry?: Partial<RetryOptions> | false;
  /** Default per-attempt timeout (ms) for all requests; `0`/undefined disables. */
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://api.openai.com";

/** Models with the built-in web-search tool (gpt-5.x, gpt-4.1, gpt-4o families). */
const WEB_SEARCH_MODELS = /^gpt-(?:5|4\.1|4o)/;

/** OpenAI has no `max`; it tops out at `xhigh`. */
const EFFORT_MAP: Record<ReasoningEffort, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
};

/** Reasoning efforts that auto-enable background mode (long generations). */
const BACKGROUND_EFFORTS = new Set<ReasoningEffort>(["high", "xhigh", "max"]);

/** Delay between background poll/retrieve requests. */
const BACKGROUND_POLL_MS = 1000;

/** Cap on SSE reconnects for a single background stream before giving up. */
const MAX_STREAM_RESUMES = 50;

interface OpenAIItem {
  type?: string;
  [key: string]: unknown;
}

interface OpenAIUsage {
  input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number };
}

export interface OpenAIResponseBody {
  id?: string;
  status?: string;
  output?: OpenAIItem[];
  usage?: OpenAIUsage;
  error?: { code?: string; message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  /** Top-level citation list emitted by some Responses-compatible servers (xAI). */
  citations?: unknown;
}

/**
 * OpenAI adapter built on the **Responses API** (`/v1/responses`), used
 * statelessly: every request sends `store: false` plus
 * `include: ["reasoning.encrypted_content"]`, so multi-turn context is
 * replayed from `messages` and reasoning survives across turns without
 * server-side storage (override via `providerOptions` if you want `store`).
 *
 * Capability notes:
 * - the Responses API has no stop-sequence parameter; `stopSequences` is
 *   ignored;
 * - `reasoning.enabled: false` maps to `effort: "none"`, which only
 *   `gpt-5.1`+ accepts — omit `reasoning` entirely for older models.
 *
 * Providers with Responses-compatible APIs (xAI) subclass this adapter and
 * override the protected hooks (base URL, API key env var, sampling-param
 * support, reasoning mapping).
 */
export class OpenAIProvider implements Provider {
  readonly name: string = "openai";
  protected readonly defaultBaseUrl: string = DEFAULT_BASE_URL;
  protected readonly apiKeyEnv: string = "OPENAI_API_KEY";
  /**
   * Whether the provider reports `reasoning_tokens` *on top of* `output_tokens`
   * (xAI: `total = input + output + reasoning`) rather than *inside* it (OpenAI:
   * reasoning is a subset of `output_tokens`). When true, {@link mapUsage} folds
   * reasoning into `output.total` so billing reflects the true output count.
   */
  protected readonly reasoningIsAdditive: boolean = false;
  private readonly options: OpenAIProviderOptions;
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: OpenAIProviderOptions = {}) {
    this.options = options;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const body = await this.buildRequestBody(options, false);
    const retry = resolveRetry(options.retry ?? this.options.retry);
    const timeoutMs = resolveTimeout(options.timeoutMs, this.options.timeoutMs);
    const response = await withRetry(
      () => this.request("/v1/responses", body, options.signal, timeoutMs),
      retry,
      options.signal,
    );
    let raw = (await response.json()) as OpenAIResponseBody;
    if (body.background === true) {
      // background returns immediately while the model runs server-side;
      // poll until the response reaches a terminal state
      raw = await this.pollBackground(raw, options.signal, retry, timeoutMs);
    }
    return this.parseResponse(raw, options);
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamEvent> {
    const body = await this.buildRequestBody(options, true);
    const retry = resolveRetry(options.retry ?? this.options.retry);
    if (body.background === true) {
      yield* this.streamBackground(body, options, retry);
      return;
    }
    const timeoutMs = resolveTimeout(options.timeoutMs, this.options.timeoutMs);
    const response = await withRetry(
      () => this.request("/v1/responses", body, options.signal, timeoutMs),
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
    const timeoutMs = resolveTimeout(options.timeoutMs, this.options.timeoutMs);
    const response = await withRetry(
      () => this.request("/v1/embeddings", body, options.signal, timeoutMs),
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

  private apiKey(): string {
    const key = this.options.apiKey ?? readEnv(this.apiKeyEnv);
    if (!key) {
      throw new CardanError(
        "auth",
        `missing ${this.name} API key: pass \`apiKey\` or set ${this.apiKeyEnv}`,
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
    const url = `${this.options.baseUrl ?? this.defaultBaseUrl}${path}`;
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

  private async requestGet(
    path: string,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<Response> {
    const url = `${this.options.baseUrl ?? this.defaultBaseUrl}${path}`;
    const { signal: composed, clear } = withTimeoutSignal(signal, timeoutMs);
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.apiKey()}`,
          ...this.options.headers,
        },
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
    let errorCode: string | undefined;
    try {
      raw = await response.json();
      const error = (raw as { error?: { message?: string; code?: string } })
        .error;
      if (error?.message) message = error.message;
      if (typeof error?.code === "string") errorCode = error.code;
    } catch {
      // keep generic message; body was not JSON
    }
    let code: ErrorCode = codeFromStatus(response.status);
    if (
      code === "invalid_request" &&
      (errorCode === "context_length_exceeded" ||
        /context (window|length)|too many tokens/i.test(message))
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
      input: convertMessages(normalizeMessages(options.messages)),
      store: false,
    };
    if (stream) body.stream = true;
    if (options.maxOutputTokens !== undefined) {
      body.max_output_tokens = options.maxOutputTokens;
    }
    if (this.supportsSamplingParams(options.model)) {
      if (options.temperature !== undefined)
        body.temperature = options.temperature;
      if (options.topP !== undefined) body.top_p = options.topP;
    }
    // note: the Responses API has no stop-sequence parameter

    const tools: Array<Record<string, unknown>> = [];
    if (options.tools?.length) {
      tools.push(
        ...(await Promise.all(
          options.tools.map(async (tool) => ({
            type: "function",
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            parameters: tool.parameters
              ? await toJsonSchema(tool.parameters)
              : { type: "object", properties: {} },
            // strict mode restricts schemas to the structured-output subset
            // (additionalProperties: false, all fields required); off so
            // arbitrary caller schemas keep working
            strict: false,
          })),
        )),
      );
    }
    const webSearch = normalizeWebSearch(options.webSearch);
    if (webSearch) {
      if (!this.supportsWebSearch(options.model)) {
        throw new CardanError(
          "invalid_request",
          `model "${options.model}" does not support web search`,
          { provider: this.name },
        );
      }
      tools.push(this.buildWebSearchTool(webSearch));
    }
    if (tools.length) body.tools = tools;
    if (options.toolChoice !== undefined) {
      body.tool_choice = convertToolChoice(options.toolChoice);
    }
    if (options.output) {
      body.text = {
        format: {
          type: "json_schema",
          name: "output",
          strict: true,
          schema: await toJsonSchema(options.output.schema),
        },
      };
    }
    if (options.reasoning) {
      const reasoning = this.convertReasoning(options.reasoning);
      if (reasoning) body.reasoning = reasoning;
    }
    if (this.resolveBackground(options)) {
      // background decouples execution from the connection; it requires
      // server-side storage so the response can be polled / the stream resumed
      body.background = true;
      body.store = true;
    }
    // Prompt caching is automatic on the Responses API; a stable cache key just
    // pins repeat requests to the same cached prefix to raise the hit rate.
    const cacheKey =
      typeof options.cache === "object" ? options.cache.key : undefined;
    if (cacheKey) body.prompt_cache_key = cacheKey;

    if (options.providerOptions) Object.assign(body, options.providerOptions);
    if (
      body.include === undefined &&
      (body.store === false || body.background === true)
    ) {
      // encrypted reasoning items keep thinking replayable from `messages`,
      // both for stateless turns and across a polled/resumed background run
      body.include = ["reasoning.encrypted_content"];
    }
    return body;
  }

  /**
   * Resolves whether to run in background mode: explicit `background` wins;
   * otherwise auto-enable for high-effort reasoning (`high`/`xhigh`/`max`),
   * whose long generations are the ones at risk of idle-connection drops.
   */
  protected resolveBackground(options: GenerateOptions): boolean {
    if (options.background !== undefined) return options.background;
    const reasoning = options.reasoning;
    if (!reasoning || reasoning.enabled === false || !reasoning.effort) {
      return false;
    }
    return BACKGROUND_EFFORTS.has(reasoning.effort);
  }

  // -------------------------------------------------------------------------
  // Capability hooks (overridden by Responses-compatible subclasses)
  // -------------------------------------------------------------------------

  /**
   * Reasoning models reject sampling parameters (`temperature`, `top_p`); the
   * adapter drops them instead of failing the request. The `*chat*` variants
   * (e.g. `gpt-5.5-chat-latest`) are non-reasoning and keep them.
   */
  protected supportsSamplingParams(model: string): boolean {
    if (/^(o[0-9]|codex)/.test(model)) return false;
    if (/^gpt-5/.test(model) && !model.includes("chat")) return false;
    return true;
  }

  /** Whether `model` supports the built-in web-search tool. */
  protected supportsWebSearch(model: string): boolean {
    return WEB_SEARCH_MODELS.test(model);
  }

  /** Builds the Responses API `web_search` tool entry from generic options. */
  protected buildWebSearchTool(
    options: WebSearchOptions,
  ): Record<string, unknown> {
    const tool: Record<string, unknown> = { type: "web_search" };
    if (options.allowedDomains?.length || options.blockedDomains?.length) {
      tool.filters = {
        ...(options.allowedDomains?.length
          ? { allowed_domains: options.allowedDomains }
          : {}),
        ...(options.blockedDomains?.length
          ? { blocked_domains: options.blockedDomains }
          : {}),
      };
    }
    if (options.contextSize) tool.search_context_size = options.contextSize;
    if (options.userLocation) {
      const loc = options.userLocation;
      tool.user_location = {
        type: "approximate",
        ...(loc.country ? { country: loc.country } : {}),
        ...(loc.city ? { city: loc.city } : {}),
        ...(loc.region ? { region: loc.region } : {}),
        ...(loc.timezone ? { timezone: loc.timezone } : {}),
      };
    }
    return tool;
  }

  /** Extracts web-search citations from a finished response. */
  protected extractCitations(raw: OpenAIResponseBody): WebCitation[] {
    const citations: WebCitation[] = [];
    for (const item of raw.output ?? []) {
      if (item.type !== "message" || !Array.isArray(item.content)) continue;
      for (const block of item.content as OpenAIItem[]) {
        const annotations = Array.isArray(block.annotations)
          ? (block.annotations as Array<Record<string, unknown>>)
          : [];
        for (const annotation of annotations) {
          if (annotation.type === "url_citation" && annotation.url) {
            addCitations(citations, [
              {
                url: String(annotation.url),
                ...(annotation.title ? { title: String(annotation.title) } : {}),
              },
            ]);
          }
        }
      }
    }
    return citations;
  }

  /** Returning undefined omits the `reasoning` field from the request. */
  protected convertReasoning(
    reasoning: NonNullable<GenerateOptions["reasoning"]>,
  ): Record<string, unknown> | undefined {
    // `none` is only accepted by gpt-5.1+; older reasoning models cannot
    // disable reasoning at all
    if (reasoning.enabled === false) return { effort: "none" };
    return {
      ...(reasoning.effort ? { effort: EFFORT_MAP[reasoning.effort] } : {}),
      // summaries are the only visible thinking the Responses API exposes
      summary: "auto",
    };
  }

  // -------------------------------------------------------------------------
  // Response
  // -------------------------------------------------------------------------

  private parseResponse(
    raw: OpenAIResponseBody,
    options: GenerateOptions,
  ): GenerateResult {
    if (raw.error || raw.status === "failed") {
      throw responseFailure(raw, this.name);
    }
    const content: ContentPart[] = [];
    for (const item of raw.output ?? []) {
      convertOutputItem(item, content, this.name);
    }
    const result: GenerateResult = {
      message: { role: "assistant", content },
      text: partsToText(content),
      finishReason: deriveFinishReason(raw),
      usage: mapUsage(raw.usage, this.reasoningIsAdditive),
      raw,
    };
    const citations = this.extractCitations(raw);
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
    for await (const { data } of parseSse(body)) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const mapped = this.mapStreamEvent(event);
      yield* mapped.events;
      if (mapped.done) return;
    }
    // stream ended without response.completed (connection cut)
    throw new CardanError("network", "stream ended unexpectedly", {
      provider: this.name,
    });
  }

  /**
   * Maps one parsed SSE event to zero or more {@link StreamEvent}s; `done` is
   * set once the terminal `response.completed`/`response.incomplete` arrives.
   * Throws on `response.failed`/`error`. Shared by the plain and background
   * streaming paths.
   */
  private mapStreamEvent(event: Record<string, unknown>): {
    events: StreamEvent[];
    done: boolean;
  } {
    switch (event.type) {
      case "response.output_text.delta":
      // refusal text surfaces as text; the finish event carries the reason
      case "response.refusal.delta":
        return {
          events: [{ type: "text_delta", text: String(event.delta ?? "") }],
          done: false,
        };
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        return {
          events: [{ type: "thinking_delta", text: String(event.delta ?? "") }],
          done: false,
        };
      case "response.output_item.done": {
        const item = event.item as OpenAIItem | undefined;
        if (item?.type === "function_call") {
          return {
            events: [
              {
                type: "tool_call",
                id: String(item.call_id ?? ""),
                name: String(item.name ?? ""),
                args: parseToolArgs(String(item.arguments ?? ""), this.name),
              },
            ],
            done: false,
          };
        }
        if (
          item?.type === "reasoning" &&
          typeof item.encrypted_content === "string" &&
          item.encrypted_content
        ) {
          return {
            events: [
              {
                type: "thinking_signature",
                signature: item.encrypted_content,
                ...(typeof item.id === "string" && item.id
                  ? { id: item.id }
                  : {}),
              },
            ],
            done: false,
          };
        }
        return { events: [], done: false };
      }
      case "response.completed":
      case "response.incomplete": {
        const response = (event.response ?? {}) as OpenAIResponseBody;
        const citations = this.extractCitations(response);
        return {
          events: [
            {
              type: "finish",
              reason: deriveFinishReason(response),
              usage: mapUsage(response.usage, this.reasoningIsAdditive),
              ...(citations.length ? { citations } : {}),
            },
          ],
          done: true,
        };
      }
      case "response.failed":
        throw responseFailure(
          (event.response ?? {}) as OpenAIResponseBody,
          this.name,
        );
      case "error":
        throw new CardanError("server", String(event.message ?? "stream error"), {
          provider: this.name,
          raw: event,
          retryable: false,
        });
      default:
        return { events: [], done: false };
    }
  }

  // -------------------------------------------------------------------------
  // Background mode (OpenAI / xAI Responses)
  // -------------------------------------------------------------------------

  /** Polls a background response until it leaves `queued`/`in_progress`. */
  private async pollBackground(
    initial: OpenAIResponseBody,
    signal: AbortSignal | undefined,
    retry: RetryOptions,
    timeoutMs: number | undefined,
  ): Promise<OpenAIResponseBody> {
    let raw = initial;
    while (raw.status === "queued" || raw.status === "in_progress") {
      if (!raw.id) {
        throw new CardanError(
          "server",
          "background response is missing an id",
          { provider: this.name, raw },
        );
      }
      await delay(BACKGROUND_POLL_MS, signal);
      const id = raw.id;
      const response = await withRetry(
        () => this.requestGet(`/v1/responses/${id}`, signal, timeoutMs),
        retry,
        signal,
      );
      raw = (await response.json()) as OpenAIResponseBody;
    }
    return raw;
  }

  /**
   * Streams a background response, transparently reconnecting a dropped SSE via
   * `GET /v1/responses/{id}?stream=true&starting_after=<sequence_number>` so a
   * cut connection no longer fails the whole run. The caller's `signal` bounds
   * the total time and is honored as a hard stop (no resume after abort).
   */
  private async *streamBackground(
    body: Record<string, unknown>,
    options: GenerateOptions,
    retry: RetryOptions,
  ): AsyncGenerator<StreamEvent> {
    const { signal } = options;
    const timeoutMs = resolveTimeout(options.timeoutMs, this.options.timeoutMs);
    let responseId: string | undefined;
    let lastSeq: number | undefined;
    let resumes = 0;
    let stream = await this.openStream(
      () => this.request("/v1/responses", body, signal, timeoutMs),
      retry,
      signal,
    );
    for (;;) {
      let done = false;
      try {
        for await (const { data } of parseSse(stream)) {
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (typeof event.sequence_number === "number") {
            lastSeq = event.sequence_number;
          }
          const response = event.response as { id?: string } | undefined;
          if (typeof response?.id === "string") responseId = response.id;
          const mapped = this.mapStreamEvent(event);
          yield* mapped.events;
          if (mapped.done) {
            done = true;
            break;
          }
        }
      } catch (error) {
        if (signal?.aborted || !this.canResume(error)) throw error;
      }
      if (done) return;
      // the SSE ended (cleanly or by a drop) before completion: resume it
      if (!responseId) {
        throw new CardanError("network", "stream ended unexpectedly", {
          provider: this.name,
        });
      }
      if (++resumes > MAX_STREAM_RESUMES) {
        throw new CardanError(
          "network",
          "exceeded background stream resume limit",
          { provider: this.name },
        );
      }
      const cursor = lastSeq ?? 0;
      stream = await this.openStream(
        () =>
          this.requestGet(
            `/v1/responses/${responseId}?stream=true&starting_after=${cursor}`,
            signal,
            timeoutMs,
          ),
        retry,
        signal,
      );
    }
  }

  /** Opens an SSE request and returns its body, retrying like other requests. */
  private async openStream(
    fn: () => Promise<Response>,
    retry: RetryOptions,
    signal: AbortSignal | undefined,
  ): Promise<ReadableStream<Uint8Array>> {
    const response = await withRetry(fn, retry, signal);
    if (!response.body) {
      throw new CardanError("network", "response has no body", {
        provider: this.name,
      });
    }
    return response.body;
  }

  /** A mid-stream failure is resumable only when it's a connection drop. */
  private canResume(error: unknown): boolean {
    // raw read errors (connection reset) aren't CardanErrors; network-coded
    // CardanErrors are drops too. Auth/server/aborted errors are not resumable.
    return isCardanError(error) ? error.code === "network" : true;
  }
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/**
 * Converts generic messages to Responses API input items. System messages
 * stay message items (the API accepts `system` anywhere in `input`);
 * assistant turns split into message / function_call / reasoning items in
 * part order; tool results become function_call_output items.
 */
function convertMessages(messages: Message[]): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    switch (message.role) {
      case "system":
        items.push({
          type: "message",
          role: "system",
          content: partsToText(message.content),
        });
        break;
      case "user": {
        const content = message.content
          .map(convertUserPart)
          .filter((part): part is Record<string, unknown> => part !== null);
        if (content.length > 0) {
          items.push({ type: "message", role: "user", content });
        }
        break;
      }
      case "assistant":
        pushAssistantItems(items, message.content);
        break;
      case "tool":
        for (const part of message.content) {
          if (part.type !== "tool_result") continue;
          items.push({
            type: "function_call_output",
            call_id: part.callId,
            output: part.isError
              ? JSON.stringify({ error: part.result })
              : typeof part.result === "string"
                ? part.result
                : JSON.stringify(part.result),
          });
        }
        break;
    }
  }
  return items;
}

function convertUserPart(part: ContentPart): Record<string, unknown> | null {
  switch (part.type) {
    case "text":
      return { type: "input_text", text: part.text };
    case "image":
      return {
        type: "input_image",
        detail: "auto",
        image_url:
          part.data instanceof URL
            ? part.data.href
            : `data:${part.mimeType};base64,${bytesToBase64(part.data)}`,
      };
    default:
      return null;
  }
}

function pushAssistantItems(
  items: Array<Record<string, unknown>>,
  content: ContentPart[],
): void {
  const texts: string[] = [];
  const flushText = () => {
    if (texts.length > 0) {
      items.push({
        type: "message",
        role: "assistant",
        content: texts.join("\n"),
      });
      texts.length = 0;
    }
  };
  for (const part of content) {
    switch (part.type) {
      case "text":
        texts.push(part.text);
        break;
      case "tool_call":
        flushText();
        items.push({
          type: "function_call",
          call_id: part.id,
          name: part.name,
          arguments: JSON.stringify(part.args ?? {}),
        });
        break;
      case "thinking":
        flushText();
        // replay needs the original item id plus encrypted payload; foreign
        // or unsigned thinking is dropped
        if (part.id && part.signature) {
          items.push({
            type: "reasoning",
            id: part.id,
            summary: part.text
              ? [{ type: "summary_text", text: part.text }]
              : [],
            encrypted_content: part.signature,
          });
        }
        break;
      default:
        // images in assistant turns are not representable
        break;
    }
  }
  flushText();
}

function convertToolChoice(
  choice: NonNullable<GenerateOptions["toolChoice"]>,
): unknown {
  if (choice === "auto" || choice === "none" || choice === "required")
    return choice;
  return { type: "function", name: choice.name };
}

function convertOutputItem(
  item: OpenAIItem,
  content: ContentPart[],
  provider: string,
): void {
  switch (item.type) {
    case "message": {
      const blocks = Array.isArray(item.content)
        ? (item.content as OpenAIItem[])
        : [];
      for (const block of blocks) {
        if (block.type === "output_text") {
          content.push({ type: "text", text: String(block.text ?? "") });
        } else if (block.type === "refusal") {
          content.push({ type: "text", text: String(block.refusal ?? "") });
        }
      }
      break;
    }
    case "function_call":
      content.push({
        type: "tool_call",
        id: String(item.call_id ?? ""),
        name: String(item.name ?? ""),
        args: parseToolArgs(String(item.arguments ?? ""), provider),
      });
      break;
    case "reasoning": {
      const part = convertReasoningItem(item);
      if (part) content.push(part);
      break;
    }
    default:
      // built-in tool calls (web_search_call, …) stay in `raw` only
      break;
  }
}

function convertReasoningItem(item: OpenAIItem): ThinkingPart | null {
  const summary = Array.isArray(item.summary)
    ? (item.summary as Array<{ text?: unknown }>)
        .map((block) => String(block.text ?? ""))
        .filter((text) => text.length > 0)
        .join("\n")
    : "";
  const encrypted =
    typeof item.encrypted_content === "string" &&
    item.encrypted_content.length > 0
      ? item.encrypted_content
      : undefined;
  if (!summary && !encrypted) return null;
  return {
    type: "thinking",
    text: summary,
    ...(typeof item.id === "string" && item.id ? { id: item.id } : {}),
    ...(encrypted ? { signature: encrypted } : {}),
  };
}

function deriveFinishReason(raw: OpenAIResponseBody): FinishReason {
  if (raw.status === "incomplete") {
    const reason = raw.incomplete_details?.reason;
    if (reason === "max_output_tokens") return "length";
    if (reason === "content_filter") return "refusal";
    return "other";
  }
  const output = raw.output ?? [];
  for (const item of output) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const block of item.content as OpenAIItem[]) {
      if (block.type === "refusal") return "refusal";
    }
  }
  if (output.some((item) => item.type === "function_call")) return "tool_calls";
  return raw.status === "completed" ? "stop" : "other";
}

function responseFailure(
  raw: OpenAIResponseBody,
  provider: string,
): CardanError {
  const code = raw.error?.code;
  const mapped: ErrorCode =
    code === "rate_limit_exceeded"
      ? "rate_limit"
      : code === "server_error"
        ? "server"
        : "unknown";
  return new CardanError(mapped, raw.error?.message ?? "response failed", {
    provider,
    raw,
    retryable: false,
  });
}

function mapUsage(
  usage: OpenAIUsage | undefined,
  reasoningIsAdditive = false,
): Usage {
  const result = emptyUsage();
  if (!usage) return result;
  // input_tokens already includes cached tokens
  result.input.total = usage.input_tokens ?? 0;
  const cached = usage.input_tokens_details?.cached_tokens;
  if (cached) result.input.details.cache_read = cached;
  result.output.total = usage.output_tokens ?? 0;
  const reasoning = usage.output_tokens_details?.reasoning_tokens;
  if (reasoning) {
    result.output.details.reasoning = reasoning;
    // xAI reports reasoning_tokens separately from output_tokens; fold it in so
    // output.total is the true billable count. OpenAI already includes it.
    if (reasoningIsAdditive) result.output.total += reasoning;
  }
  return result;
}

