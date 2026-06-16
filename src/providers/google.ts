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
  base64ToBytes,
  bytesToBase64,
  isSyntheticCallId,
  normalizeWebSearch,
  parseStructuredOutput,
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

export type GoogleModel =
  | "gemini-3.5-flash"
  | "gemini-3.1-pro-preview"
  | "gemini-3.1-flash-lite"
  | "gemini-3-flash-preview"
  | "gemini-embedding-001"
  | (string & {});

export interface GoogleProviderOptions {
  /** Defaults to `GEMINI_API_KEY`, falling back to `GOOGLE_API_KEY`. */
  apiKey?: string;
  /** Defaults to `https://generativelanguage.googleapis.com`. */
  baseUrl?: string;
  /** API version path segment. Defaults to `v1beta`. */
  apiVersion?: string;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  /** Custom fetch implementation (testing, proxies). */
  fetch?: typeof globalThis.fetch;
  /** Default retry behavior for all requests; `false` disables. */
  retry?: Partial<RetryOptions> | false;
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_API_VERSION = "v1beta";

/** Models that take `thinkingLevel` (Gemini 3+); older ones take `thinkingBudget`. */
const THINKING_LEVEL_MODELS = /^gemini-(?:[3-9]|\d{2})/;

/** Pre-2.0 models use the legacy `google_search_retrieval` grounding tool. */
const SEARCH_RETRIEVAL_MODELS = /^gemini-1\./;

const THINKING_LEVEL: Record<ReasoningEffort, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

const THINKING_BUDGET: Record<ReasoningEffort, number> = {
  low: 1024,
  medium: 8192,
  high: 24576,
  xhigh: 24576,
  max: 24576,
};

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType?: string; data?: string };
  fileData?: { mimeType?: string; fileUri?: string };
  functionCall?: { id?: string; name?: string; args?: unknown };
  functionResponse?: { id?: string; name?: string; response?: unknown };
  [key: string]: unknown;
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}

interface GeminiGroundingMetadata {
  groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
}

interface GeminiCandidate {
  content?: { role?: string; parts?: GeminiPart[] };
  finishReason?: string;
  groundingMetadata?: GeminiGroundingMetadata;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  promptFeedback?: { blockReason?: string };
}

export class GoogleProvider implements Provider {
  readonly name = "google";
  private readonly options: GoogleProviderOptions;
  private readonly fetch: typeof globalThis.fetch;

  constructor(options: GoogleProviderOptions = {}) {
    this.options = options;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const body = await this.buildRequestBody(options);
    const retry = resolveRetry(options.retry ?? this.options.retry);
    const response = await withRetry(
      () =>
        this.request(
          this.modelUrl(options.model, "generateContent"),
          body,
          options.signal,
        ),
      retry,
      options.signal,
    );
    const raw = (await response.json()) as GeminiResponse;
    return this.parseResponse(raw, options);
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamEvent> {
    const body = await this.buildRequestBody(options);
    const retry = resolveRetry(options.retry ?? this.options.retry);
    const response = await withRetry(
      () =>
        this.request(
          `${this.modelUrl(options.model, "streamGenerateContent")}?alt=sse`,
          body,
          options.signal,
        ),
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
    const model = stripModelsPrefix(options.model);
    const body: Record<string, unknown> = {
      requests: options.input.map((text) => ({
        model: `models/${model}`,
        content: { parts: [{ text }] },
        ...options.providerOptions,
      })),
    };
    const retry = resolveRetry(options.retry ?? this.options.retry);
    const response = await withRetry(
      () =>
        this.request(
          this.modelUrl(model, "batchEmbedContents"),
          body,
          options.signal,
        ),
      retry,
      options.signal,
    );
    const raw = (await response.json()) as {
      embeddings?: Array<{ values?: number[] }>;
    };
    return {
      embeddings: (raw.embeddings ?? []).map(
        (embedding) => embedding.values ?? [],
      ),
      // batchEmbedContents returns no usage metadata
      usage: emptyUsage(),
      raw,
    };
  }

  // -------------------------------------------------------------------------
  // Request
  // -------------------------------------------------------------------------

  private apiKey(): string {
    const key =
      this.options.apiKey ??
      readEnv("GEMINI_API_KEY") ??
      readEnv("GOOGLE_API_KEY");
    if (!key) {
      throw new CardanError(
        "auth",
        "missing Gemini API key: pass `apiKey` or set GEMINI_API_KEY",
        { provider: this.name },
      );
    }
    return key;
  }

  private modelUrl(model: string, method: string): string {
    const base = this.options.baseUrl ?? DEFAULT_BASE_URL;
    const version = this.options.apiVersion ?? DEFAULT_API_VERSION;
    return `${base}/${version}/models/${stripModelsPrefix(model)}:${method}`;
  }

  private async request(
    url: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.apiKey(),
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
    let retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    try {
      raw = await response.json();
      const error = (
        raw as { error?: { message?: string; details?: unknown[] } }
      ).error;
      if (error?.message) message = error.message;
      retryAfterMs ??= retryDelayFromDetails(error?.details);
    } catch {
      // keep generic message; body was not JSON
    }
    let code: ErrorCode = codeFromStatus(response.status);
    if (
      code === "invalid_request" &&
      /token count|exceeds the maximum number of tokens|context (length|window)/i.test(
        message,
      )
    ) {
      code = "context_length";
    }
    return new CardanError(code, message, {
      provider: this.name,
      status: response.status,
      retryAfterMs,
      raw,
    });
  }

  private async buildRequestBody(
    options: GenerateOptions,
  ): Promise<Record<string, unknown>> {
    const { system, messages } = splitLeadingSystem(
      normalizeMessages(options.messages),
    );
    const callNames = collectCallNames(messages);

    const body: Record<string, unknown> = {
      contents: convertMessages(messages, callNames),
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };

    const tools: Array<Record<string, unknown>> = [];
    if (options.tools?.length) {
      tools.push({
        functionDeclarations: await Promise.all(
          options.tools.map(async (tool) => ({
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            ...(tool.parameters
              ? { parametersJsonSchema: await toJsonSchema(tool.parameters) }
              : {}),
          })),
        ),
      });
    }
    // Grounding with Google Search; the tool has no domain/location knobs, so
    // WebSearchOptions fields are ignored (use providerOptions for raw control)
    if (normalizeWebSearch(options.webSearch)) {
      const model = stripModelsPrefix(options.model);
      if (!model.startsWith("gemini-")) {
        throw new CardanError(
          "invalid_request",
          `model "${options.model}" does not support web search`,
          { provider: this.name },
        );
      }
      tools.push(
        SEARCH_RETRIEVAL_MODELS.test(model)
          ? { google_search_retrieval: {} }
          : { google_search: {} },
      );
    }
    if (tools.length) body.tools = tools;
    if (options.toolChoice !== undefined) {
      body.toolConfig = {
        functionCallingConfig: convertToolChoice(options.toolChoice),
      };
    }

    const generationConfig: Record<string, unknown> = {};
    if (options.maxOutputTokens !== undefined) {
      generationConfig.maxOutputTokens = options.maxOutputTokens;
    }
    if (options.temperature !== undefined)
      generationConfig.temperature = options.temperature;
    if (options.topP !== undefined) generationConfig.topP = options.topP;
    if (options.stopSequences?.length)
      generationConfig.stopSequences = options.stopSequences;
    if (options.output) {
      generationConfig.responseMimeType = "application/json";
      generationConfig.responseJsonSchema = await toJsonSchema(
        options.output.schema,
      );
    }
    if (options.reasoning) {
      const thinking = thinkingConfig(options.model, options.reasoning);
      if (Object.keys(thinking).length > 0)
        generationConfig.thinkingConfig = thinking;
    }
    if (Object.keys(generationConfig).length > 0)
      body.generationConfig = generationConfig;

    if (options.providerOptions) Object.assign(body, options.providerOptions);
    return body;
  }

  // -------------------------------------------------------------------------
  // Response
  // -------------------------------------------------------------------------

  private parseResponse(
    raw: GeminiResponse,
    options: GenerateOptions,
  ): GenerateResult {
    const candidate = raw.candidates?.[0];
    const content: ContentPart[] = [];
    for (const part of candidate?.content?.parts ?? []) {
      const converted = convertResponsePart(part);
      if (converted) content.push(converted);
    }
    const hasToolCall = content.some((part) => part.type === "tool_call");
    const blocked = !candidate && raw.promptFeedback?.blockReason !== undefined;
    const result: GenerateResult = {
      message: { role: "assistant", content },
      finishReason: blocked
        ? "refusal"
        : mapFinishReason(candidate?.finishReason, hasToolCall),
      usage: mapUsage(raw.usageMetadata),
      raw,
    };
    const citations: WebCitation[] = [];
    extractGroundingCitations(candidate?.groundingMetadata, citations);
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
    let usage = emptyUsage();
    let finishReason: string | undefined;
    let hasToolCall = false;
    let blocked = false;
    const citations: WebCitation[] = [];

    for await (const { data } of parseSse(body)) {
      let chunk: GeminiResponse & { error?: { message?: string } };
      try {
        chunk = JSON.parse(data) as GeminiResponse & {
          error?: { message?: string };
        };
      } catch {
        continue;
      }
      if (chunk.error) {
        throw new CardanError("server", chunk.error.message ?? "stream error", {
          provider: this.name,
          raw: chunk,
          retryable: false,
        });
      }
      // usageMetadata is cumulative; the latest chunk wins
      if (chunk.usageMetadata) usage = mapUsage(chunk.usageMetadata);
      if (chunk.promptFeedback?.blockReason !== undefined) blocked = true;

      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (part.functionCall) {
          hasToolCall = true;
          yield {
            type: "tool_call",
            id: part.functionCall.id || syntheticCallId(),
            name: String(part.functionCall.name ?? ""),
            args: part.functionCall.args ?? {},
            ...(part.thoughtSignature
              ? { signature: part.thoughtSignature }
              : {}),
          };
        } else if (
          typeof part.text === "string" &&
          (part.text.length > 0 || part.thoughtSignature)
        ) {
          // any Part can carry a thoughtSignature (Gemini 3), not just function
          // calls; ride it on the delta so the signed part survives collection
          const signature = part.thoughtSignature
            ? { signature: part.thoughtSignature }
            : {};
          if (part.thought) {
            yield { type: "thinking_delta", text: part.text, ...signature };
          } else {
            yield { type: "text_delta", text: part.text, ...signature };
          }
        }
      }
      if (candidate?.groundingMetadata) {
        extractGroundingCitations(candidate.groundingMetadata, citations);
      }
      if (candidate?.finishReason) finishReason = candidate.finishReason;
    }

    if (finishReason === undefined && !blocked) {
      // a complete Gemini stream always carries finishReason in its last chunk
      throw new CardanError("network", "stream ended unexpectedly", {
        provider: this.name,
      });
    }
    yield {
      type: "finish",
      reason: blocked ? "refusal" : mapFinishReason(finishReason, hasToolCall),
      usage,
      ...(citations.length ? { citations } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

function stripModelsPrefix(model: string): string {
  return model.startsWith("models/") ? model.slice("models/".length) : model;
}

/** Pulls cited web sources out of Gemini grounding metadata. */
function extractGroundingCitations(
  metadata: GeminiGroundingMetadata | undefined,
  out: WebCitation[],
): void {
  for (const chunk of metadata?.groundingChunks ?? []) {
    const web = chunk.web;
    if (web?.uri) {
      addCitations(out, [
        {
          url: String(web.uri),
          ...(web.title ? { title: String(web.title) } : {}),
        },
      ]);
    }
  }
}

/** Maps call id → tool name, so functionResponse parts can carry `name`. */
function collectCallNames(messages: Message[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "tool_call") names.set(part.id, part.name);
    }
  }
  return names;
}

/**
 * Converts generic messages to Gemini `contents`. Roles map user→user,
 * assistant→model, tool→user (functionResponse parts travel in user turns);
 * contents that end up with the same role are merged, since some models
 * enforce strict user/model alternation.
 */
function convertMessages(
  messages: Message[],
  callNames: Map<string, string>,
): Array<Record<string, unknown>> {
  const contents: Array<{ role: string; parts: unknown[] }> = [];
  for (const message of messages) {
    const role = message.role === "assistant" ? "model" : "user";
    const parts = message.content
      .map((part) => convertRequestPart(part, callNames))
      .filter((part) => part !== null);
    if (parts.length === 0) continue;
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  }
  return contents;
}

function convertRequestPart(
  part: ContentPart,
  callNames: Map<string, string>,
): Record<string, unknown> | null {
  switch (part.type) {
    case "text":
      return {
        text: part.text,
        ...(part.signature ? { thoughtSignature: part.signature } : {}),
      };
    case "image":
      return part.data instanceof URL
        ? { fileData: { mimeType: part.mimeType, fileUri: part.data.href } }
        : {
            inlineData: {
              mimeType: part.mimeType,
              data: bytesToBase64(part.data),
            },
          };
    case "tool_call":
      return {
        functionCall: {
          ...(isSyntheticCallId(part.id) ? {} : { id: part.id }),
          name: part.name,
          args: part.args ?? {},
        },
        ...(part.signature ? { thoughtSignature: part.signature } : {}),
      };
    case "tool_result":
      return {
        functionResponse: {
          ...(isSyntheticCallId(part.callId) ? {} : { id: part.callId }),
          name: callNames.get(part.callId) ?? part.callId,
          response: convertToolResult(part.result, part.isError),
        },
      };
    case "thinking":
      // foreign opaque blocks (Anthropic redacted_thinking) cannot replay here
      if (part.redacted) return null;
      // unsigned thought summaries need not be replayed
      if (!part.signature) return null;
      return {
        text: part.text,
        thought: true,
        thoughtSignature: part.signature,
      };
  }
}

/** `functionResponse.response` must be a JSON object; wrap other values. */
function convertToolResult(
  result: unknown,
  isError?: boolean,
): Record<string, unknown> {
  if (isError) {
    return {
      error: typeof result === "string" ? result : JSON.stringify(result),
    };
  }
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return { result };
}

function convertToolChoice(
  choice: NonNullable<GenerateOptions["toolChoice"]>,
): Record<string, unknown> {
  if (choice === "auto") return { mode: "AUTO" };
  if (choice === "none") return { mode: "NONE" };
  if (choice === "required") return { mode: "ANY" };
  return { mode: "ANY", allowedFunctionNames: [choice.name] };
}

function thinkingConfig(
  model: string,
  reasoning: NonNullable<GenerateOptions["reasoning"]>,
): Record<string, unknown> {
  const useLevel = THINKING_LEVEL_MODELS.test(stripModelsPrefix(model));
  const config: Record<string, unknown> = {};
  if (reasoning.enabled === false) {
    // Gemini 3 cannot disable thinking entirely; "minimal" is the floor
    if (useLevel) config.thinkingLevel = "minimal";
    else config.thinkingBudget = 0;
    return config;
  }
  // past the disable check, reasoning is on (effort implies enabled); surface
  // thought summaries so callers actually receive the thinking they asked for
  config.includeThoughts = true;
  if (reasoning.effort) {
    if (useLevel) config.thinkingLevel = THINKING_LEVEL[reasoning.effort];
    else config.thinkingBudget = THINKING_BUDGET[reasoning.effort];
  }
  return config;
}

function convertResponsePart(part: GeminiPart): ContentPart | null {
  if (part.functionCall) {
    return {
      type: "tool_call",
      id: part.functionCall.id || syntheticCallId(),
      name: String(part.functionCall.name ?? ""),
      args: part.functionCall.args ?? {},
      ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}),
    };
  }
  if (typeof part.text === "string") {
    if (part.thought) {
      return {
        type: "thinking",
        text: part.text,
        ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}),
      };
    }
    return {
      type: "text",
      text: part.text,
      ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}),
    };
  }
  if (part.inlineData?.data) {
    return {
      type: "image",
      mimeType: part.inlineData.mimeType ?? "application/octet-stream",
      data: base64ToBytes(part.inlineData.data),
    };
  }
  // unknown part kinds (executableCode, …) stay in `raw` only
  return null;
}

function mapFinishReason(
  reason: string | undefined,
  hasToolCall: boolean,
): FinishReason {
  // Gemini reports STOP even when the turn ends in function calls
  if (hasToolCall) return "tool_calls";
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "IMAGE_SAFETY":
      return "refusal";
    default:
      return "other";
  }
}

function mapUsage(usage: GeminiUsageMetadata | undefined): Usage {
  const result = emptyUsage();
  if (!usage) return result;
  // promptTokenCount already includes cached tokens
  result.input.total = usage.promptTokenCount ?? 0;
  if (usage.cachedContentTokenCount) {
    result.input.details.cache_read = usage.cachedContentTokenCount;
  }
  result.output.total =
    (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  if (usage.thoughtsTokenCount) {
    result.output.details.reasoning = usage.thoughtsTokenCount;
  }
  return result;
}

/** Parses `RetryInfo.retryDelay` (e.g. `"30s"`) from Google error details. */
function retryDelayFromDetails(
  details: unknown[] | undefined,
): number | undefined {
  if (!details) return undefined;
  for (const detail of details) {
    const retryDelay = (detail as { retryDelay?: unknown }).retryDelay;
    if (typeof retryDelay === "string") {
      const seconds = Number.parseFloat(retryDelay);
      if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    }
  }
  return undefined;
}

