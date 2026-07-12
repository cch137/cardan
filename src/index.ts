import { CardanError, isCardanError } from "./errors.js";
import {
  AnthropicProvider,
  type AnthropicModelId,
  type AnthropicProviderOptions,
} from "./providers/anthropic.js";
import {
  GoogleProvider,
  type GoogleModelId,
  type GoogleProviderOptions,
} from "./providers/google.js";
import {
  GroqProvider,
  type GroqModelId,
  type GroqProviderOptions,
} from "./providers/groq.js";
import {
  ModalProvider,
  type ModalProviderOptions,
} from "./providers/modal.js";
import {
  OpenAIProvider,
  type OpenAIModelId,
  type OpenAIProviderOptions,
} from "./providers/openai.js";
import {
  XAIProvider,
  type XAIModelId,
  type XAIProviderOptions,
} from "./providers/xai.js";
import {
  XAIOAuthProvider,
  type XAIOAuthProviderOptions,
} from "./providers/xai-oauth.js";
import { readEnv, warnOnce } from "./env.js";
import type {
  EmbedOptions,
  EmbedResult,
  GenerateOptions,
  GenerateResult,
  Provider,
  StreamEvent,
  TelemetryEvent,
  TelemetryOptions,
  Usage,
} from "./types.js";
import type { Infer, SchemaInput } from "./schema.js";
import { Conversation, type ConversationOptions } from "./conversation.js";
import { Agent, type AgentSpec } from "./agent.js";

export type {
  ContentPart,
  EmbedOptions,
  EmbedResult,
  FinishReason,
  GenerateOptions,
  GenerateResult,
  ImagePart,
  Message,
  Provider,
  RateLimitCounter,
  RateLimitStatus,
  RateLimitWindow,
  ReasoningEffort,
  RetryOptions,
  Role,
  StreamEvent,
  TelemetryEvent,
  TelemetryOptions,
  TextPart,
  ThinkingPart,
  Tool,
  ToolCallPart,
  ToolChoice,
  ToolResultPart,
  Usage,
  WebCitation,
  WebSearchOptions,
} from "./types.js";
export { DEFAULT_RETRY, emptyUsage, textMessage } from "./types.js";
export {
  CardanError,
  codeFromProviderType,
  extractProviderError,
  isCardanError,
  streamCardanError,
  type ErrorCode,
  type ExtractedProviderError,
} from "./errors.js";
export type { Infer, JsonSchema, SchemaInput, ZodLikeSchema } from "./schema.js";
export {
  type AskOptions,
  type CallInfo,
  type Compactor,
  Conversation,
  type ConversationClient,
  type ConversationOptions,
  defineTool,
  dropToolRounds,
  redactToolResults,
  type ToolHandler,
} from "./conversation.js";
export { Agent, type AgentSpec, type Memory } from "./agent.js";
export { parallel } from "./concurrency.js";
export { normalizeMessages } from "./normalize.js";
export { collectStream, collectStreamToMessage } from "./stream.js";
export {
  AnthropicProvider,
  type AnthropicExperimentalOptions,
  type AnthropicModel,
  type AnthropicModelId,
  type AnthropicOAuthOptions,
  type AnthropicProviderOptions,
  type OAuthCredentials,
} from "./providers/anthropic.js";
export {
  GoogleProvider,
  type GoogleModel,
  type GoogleModelId,
  type GoogleProviderOptions,
} from "./providers/google.js";
export {
  GroqProvider,
  type GroqModel,
  type GroqModelId,
  type GroqProviderOptions,
} from "./providers/groq.js";
export {
  ModalProvider,
  type ModalModel,
  type ModalProviderOptions,
} from "./providers/modal.js";
export {
  OpenAIProvider,
  type OpenAIModel,
  type OpenAIModelId,
  type OpenAIProviderOptions,
} from "./providers/openai.js";
export {
  XAIProvider,
  type XAIModel,
  type XAIModelId,
  type XAIProviderOptions,
} from "./providers/xai.js";
export {
  XAIOAuthProvider,
  createXAIOAuthProvider,
  GROK_AUTH_SCOPE,
  type XAIOAuthCredentials,
  type XAIOAuthProviderOptions,
  type XAISubscriptionUsage,
} from "./providers/xai-oauth.js";
export {
  PoolProvider,
  createPool,
  type PoolBehavior,
  type PoolFailoverInfo,
  type PoolMember,
  type PoolMemberInput,
  type PoolOptions,
} from "./pool.js";

// ---------------------------------------------------------------------------
// Unified entry
// ---------------------------------------------------------------------------

/**
 * `provider/model` string. Split on the first `/` only — the remainder is
 * passed verbatim to the provider (model names may themselves contain `/`).
 */
export type ModelId =
  | `anthropic/${AnthropicModelId}`
  | `google/${GoogleModelId}`
  | `groq/${GroqModelId}`
  | `openai/${OpenAIModelId}`
  | `xai/${XAIModelId}`
  | (`${string}/${string}` & {});

export interface CardanConfig {
  anthropic?: AnthropicProviderOptions;
  google?: GoogleProviderOptions;
  groq?: GroqProviderOptions;
  /** Self-deployed models on Modal; `baseUrl` is per-deployment. */
  modal?: ModalProviderOptions;
  openai?: OpenAIProviderOptions;
  xai?: XAIProviderOptions;
  /** Grok Build subscription (`grok login`) for the `xai` prefix; see auth precedence. */
  xaiOAuth?: XAIOAuthProviderOptions;
  /** Additional or overriding providers, keyed by prefix. */
  providers?: Record<string, Provider>;
  /**
   * Global observer fired once per logical `generate` / `stream` / `embed`
   * (after pool failover / per-attempt retries). Absent = no instrumentation.
   */
  telemetry?: TelemetryOptions;
}

type Prefixed<T extends { model: string }> = Omit<T, "model"> & { model: ModelId };

/** Error fields copied into a failed {@link TelemetryEvent}. */
function telemetryErrorFields(
  error: unknown,
): Pick<TelemetryEvent, "errorCode" | "status" | "retryAfterMs" | "resetAt"> {
  if (isCardanError(error)) {
    return {
      errorCode: error.code,
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(error.retryAfterMs !== undefined
        ? { retryAfterMs: error.retryAfterMs }
        : {}),
      ...(error.resetAt !== undefined ? { resetAt: error.resetAt } : {}),
    };
  }
  return { errorCode: "unknown" };
}

export class Cardan {
  private readonly config: CardanConfig;
  private readonly cache = new Map<string, Provider>();

  constructor(config: CardanConfig = {}) {
    this.config = config;
  }

  provider(name: string): Provider {
    const custom = this.config.providers?.[name];
    if (custom) return custom;
    const cached = this.cache.get(name);
    if (cached) return cached;
    let provider: Provider;
    switch (name) {
      case "anthropic":
        provider = new AnthropicProvider(this.config.anthropic);
        break;
      case "google":
        provider = new GoogleProvider(this.config.google);
        break;
      case "groq":
        provider = new GroqProvider(this.config.groq);
        break;
      case "modal":
        provider = new ModalProvider(this.config.modal);
        break;
      case "openai":
        provider = new OpenAIProvider(this.config.openai);
        break;
      case "xai":
        provider = this.resolveXAI();
        break;
      default:
        throw new CardanError("invalid_request", `unknown provider "${name}"`);
    }
    this.cache.set(name, provider);
    return provider;
  }

  /**
   * Selects the `xai` auth path. Precedence (most explicit first): config
   * `xaiOAuth` > config `xai.apiKey` > env `GROK_BUILD_OAUTH_TOKEN`
   * (Grok Build subscription) > env `XAI_API_KEY`. A bare env token is
   * inference-only (no refresh); pass `xaiOAuth` for the refreshable flow.
   */
  private resolveXAI(): Provider {
    if (this.config.xaiOAuth) return new XAIOAuthProvider(this.config.xaiOAuth);
    if (this.config.xai?.apiKey) return new XAIProvider(this.config.xai);
    const token = readEnv("GROK_BUILD_OAUTH_TOKEN");
    if (token) {
      if (readEnv("XAI_API_KEY")) {
        warnOnce(
          "xai-dual-env",
          "both GROK_BUILD_OAUTH_TOKEN and XAI_API_KEY are set; using the OAuth " +
            "(subscription) token. Unset GROK_BUILD_OAUTH_TOKEN to use the API key.",
        );
      }
      return new XAIOAuthProvider({ credentials: { accessToken: token } });
    }
    return new XAIProvider(this.config.xai);
  }

  async generate<S extends SchemaInput = SchemaInput>(
    options: Prefixed<GenerateOptions<S>>,
  ): Promise<GenerateResult<Infer<S>>> {
    const { provider, model, prefix } = this.route(options.model);
    if (!this.config.telemetry?.onRequest) {
      return provider.generate({ ...options, model }) as Promise<
        GenerateResult<Infer<S>>
      >;
    }
    const start = Date.now();
    try {
      const result = (await provider.generate({
        ...options,
        model,
      })) as GenerateResult<Infer<S>>;
      this.emitTelemetry({
        provider: prefix,
        model,
        op: "generate",
        ok: true,
        durationMs: Date.now() - start,
        usage: result.usage,
      });
      return result;
    } catch (error) {
      this.emitTelemetry({
        provider: prefix,
        model,
        op: "generate",
        ok: false,
        durationMs: Date.now() - start,
        ...telemetryErrorFields(error),
      });
      throw error;
    }
  }

  stream(options: Prefixed<GenerateOptions>): AsyncIterable<StreamEvent> {
    const { provider, model, prefix } = this.route(options.model);
    const inner = provider.stream({ ...options, model });
    if (!this.config.telemetry?.onRequest) return inner;
    return this.streamWithTelemetry(inner, prefix, model);
  }

  /** Start a stateful {@link Conversation} bound to this client's config. */
  conversation(options: ConversationOptions): Conversation {
    return new Conversation(this, options);
  }

  /** Build an {@link Agent}: a reusable identity (+ optional cross-session memory)
   *  over this client. The agent has no runtime of its own — it builds
   *  Conversations on demand. */
  agent(spec: AgentSpec): Agent {
    return new Agent(this, spec);
  }

  async embed(options: Prefixed<EmbedOptions>): Promise<EmbedResult> {
    const { provider, model, prefix } = this.route(options.model);
    if (!this.config.telemetry?.onRequest) {
      if (!provider.embed) {
        throw new CardanError(
          "invalid_request",
          `provider "${provider.name}" does not support embeddings`,
        );
      }
      return provider.embed({ ...options, model });
    }
    const start = Date.now();
    try {
      if (!provider.embed) {
        throw new CardanError(
          "invalid_request",
          `provider "${provider.name}" does not support embeddings`,
        );
      }
      const result = await provider.embed({ ...options, model });
      this.emitTelemetry({
        provider: prefix,
        model,
        op: "embed",
        ok: true,
        durationMs: Date.now() - start,
      });
      return result;
    } catch (error) {
      this.emitTelemetry({
        provider: prefix,
        model,
        op: "embed",
        ok: false,
        durationMs: Date.now() - start,
        ...telemetryErrorFields(error),
      });
      throw error;
    }
  }

  private route(id: string): {
    provider: Provider;
    model: string;
    prefix: string;
  } {
    const slash = id.indexOf("/");
    if (slash <= 0 || slash === id.length - 1) {
      throw new CardanError(
        "invalid_request",
        `invalid model id "${id}": expected "provider/model"`,
      );
    }
    const prefix = id.slice(0, slash);
    return {
      provider: this.provider(prefix),
      model: id.slice(slash + 1),
      prefix,
    };
  }

  /** Fire `telemetry.onRequest`, swallowing observer failures. */
  private emitTelemetry(event: TelemetryEvent): void {
    try {
      this.config.telemetry?.onRequest?.(event);
    } catch {
      // a broken observer must never affect the request
    }
  }

  /**
   * Wrap a provider stream: one telemetry event on normal completion, throw,
   * or early consumer abandon (`return` before finish → `ok: true`, no usage).
   * `durationMs` starts at the first `next()`.
   */
  private async *streamWithTelemetry(
    source: AsyncIterable<StreamEvent>,
    prefix: string,
    model: string,
  ): AsyncGenerator<StreamEvent> {
    let started = false;
    let start = 0;
    let usage: Usage | undefined;
    let emitted = false;

    const fire = (partial: {
      ok: boolean;
      usage?: Usage;
      errorCode?: TelemetryEvent["errorCode"];
      status?: number;
      retryAfterMs?: number;
      resetAt?: number;
    }): void => {
      if (emitted) return;
      emitted = true;
      this.emitTelemetry({
        provider: prefix,
        model,
        op: "stream",
        durationMs: started ? Date.now() - start : 0,
        ...partial,
      });
    };

    try {
      const it = source[Symbol.asyncIterator]();
      while (true) {
        if (!started) {
          started = true;
          start = Date.now();
        }
        const step = await it.next();
        if (step.done) break;
        const event = step.value;
        if (event.type === "finish") usage = event.usage;
        yield event;
      }
      fire({ ok: true, ...(usage !== undefined ? { usage } : {}) });
    } catch (error) {
      fire({ ok: false, ...telemetryErrorFields(error) });
      throw error;
    } finally {
      // consumer abandoned the iterator before finish/error
      if (!emitted) fire({ ok: true });
    }
  }
}

export function createCardan(config: CardanConfig = {}): Cardan {
  return new Cardan(config);
}
