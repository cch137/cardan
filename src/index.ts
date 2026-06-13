import { CardanError } from "./errors.js";
import {
  AnthropicProvider,
  type AnthropicModel,
  type AnthropicProviderOptions,
} from "./providers/anthropic.js";
import {
  GeminiProvider,
  type GeminiModel,
  type GeminiProviderOptions,
} from "./providers/gemini.js";
import {
  GroqProvider,
  type GroqModel,
  type GroqProviderOptions,
} from "./providers/groq.js";
import {
  ModalProvider,
  type ModalProviderOptions,
} from "./providers/modal.js";
import {
  OpenAIProvider,
  type OpenAIModel,
  type OpenAIProviderOptions,
} from "./providers/openai.js";
import {
  XAIProvider,
  type XAIModel,
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
} from "./types.js";
export { DEFAULT_RETRY, emptyUsage, textMessage } from "./types.js";
export { CardanError, isCardanError, type ErrorCode } from "./errors.js";
export type { JsonSchema, SchemaInput, ZodLikeSchema } from "./schema.js";
export { normalizeMessages } from "./normalize.js";
export { collectStream } from "./stream.js";
export {
  AnthropicProvider,
  type AnthropicModel,
  type AnthropicProviderOptions,
} from "./providers/anthropic.js";
export {
  GeminiProvider,
  type GeminiModel,
  type GeminiProviderOptions,
} from "./providers/gemini.js";
export {
  GroqProvider,
  type GroqModel,
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
  type OpenAIProviderOptions,
} from "./providers/openai.js";
export {
  XAIProvider,
  type XAIModel,
  type XAIProviderOptions,
} from "./providers/xai.js";

// ---------------------------------------------------------------------------
// Unified entry
// ---------------------------------------------------------------------------

/**
 * `provider/model` string. Split on the first `/` only — the remainder is
 * passed verbatim to the provider (model names may themselves contain `/`).
 */
export type ModelId =
  | `anthropic/${AnthropicModel}`
  | `gemini/${GeminiModel}`
  | `groq/${GroqModel}`
  | `openai/${OpenAIModel}`
  | `xai/${XAIModel}`
  | (`${string}/${string}` & {});

export interface CardanConfig {
  anthropic?: AnthropicProviderOptions;
  gemini?: GeminiProviderOptions;
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
      case "gemini":
        provider = new GeminiProvider(this.config.gemini);
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

  generate(options: Prefixed<GenerateOptions>): Promise<GenerateResult> {
    const { provider, model } = this.route(options.model);
    return provider.generate({ ...options, model });
  }

  stream(options: Prefixed<GenerateOptions>): AsyncIterable<StreamEvent> {
    const { provider, model } = this.route(options.model);
    return provider.stream({ ...options, model });
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
