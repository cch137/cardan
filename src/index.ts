import { CardanError } from "./errors.js";
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
import type {
  EmbedOptions,
  EmbedResult,
  GenerateOptions,
  GenerateResult,
  Provider,
  StreamEvent,
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
  ReasoningEffort,
  RetryOptions,
  Role,
  StreamEvent,
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
export { CardanError, isCardanError, type ErrorCode } from "./errors.js";
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
  /** Additional or overriding providers, keyed by prefix. */
  providers?: Record<string, Provider>;
}

type Prefixed<T extends { model: string }> = Omit<T, "model"> & { model: ModelId };

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
        provider = new XAIProvider(this.config.xai);
        break;
      default:
        throw new CardanError("invalid_request", `unknown provider "${name}"`);
    }
    this.cache.set(name, provider);
    return provider;
  }

  generate<S extends SchemaInput = SchemaInput>(
    options: Prefixed<GenerateOptions<S>>,
  ): Promise<GenerateResult<Infer<S>>> {
    const { provider, model } = this.route(options.model);
    return provider.generate({ ...options, model }) as Promise<
      GenerateResult<Infer<S>>
    >;
  }

  stream(options: Prefixed<GenerateOptions>): AsyncIterable<StreamEvent> {
    const { provider, model } = this.route(options.model);
    return provider.stream({ ...options, model });
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

  embed(options: Prefixed<EmbedOptions>): Promise<EmbedResult> {
    const { provider, model } = this.route(options.model);
    if (!provider.embed) {
      throw new CardanError(
        "invalid_request",
        `provider "${provider.name}" does not support embeddings`,
      );
    }
    return provider.embed({ ...options, model });
  }

  private route(id: string): { provider: Provider; model: string } {
    const slash = id.indexOf("/");
    if (slash <= 0 || slash === id.length - 1) {
      throw new CardanError(
        "invalid_request",
        `invalid model id "${id}": expected "provider/model"`,
      );
    }
    return {
      provider: this.provider(id.slice(0, slash)),
      model: id.slice(slash + 1),
    };
  }
}

export function createCardan(config: CardanConfig = {}): Cardan {
  return new Cardan(config);
}
