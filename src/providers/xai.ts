import { CardanError } from "../errors.js";
import { addCitations } from "../util.js";
import type {
  EmbedOptions,
  EmbedResult,
  GenerateOptions,
  ReasoningEffort,
  RetryOptions,
  WebCitation,
  WebSearchOptions,
} from "../types.js";
import { OpenAIProvider, type OpenAIResponseBody } from "./openai.js";

/** Known xAI model ids — literal-only, drives editor autocomplete. */
export type XAIModelId =
  | "grok-4.5"
  | "grok-4.20-0309-reasoning"
  | "grok-4.20-0309-non-reasoning"
  | "grok-4.20-multi-agent-0309"
  | "grok-4-fast-reasoning"
  | "grok-4-fast-non-reasoning"
  | "grok-code-fast-1";

export type XAIModel = XAIModelId | (string & {});

export interface XAIProviderOptions {
  /** Defaults to the `XAI_API_KEY` environment variable. */
  apiKey?: string;
  /** Defaults to `https://api.x.ai`. */
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

/** xAI tops out at `high` (no `xhigh`); `none` disables reasoning. */
const EFFORT_MAP: Record<ReasoningEffort, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

/** Grok models with the server-side `web_search` tool (Live Search successor). */
const WEB_SEARCH_MODELS = /^grok-(?:4|[5-9])/;

/** xAI caps domain filters at five entries. */
const MAX_SEARCH_DOMAINS = 5;

/**
 * xAI Grok adapter. xAI's Responses API (`/v1/responses`) is wire-compatible
 * with OpenAI's (their Chat Completions endpoint is documented as legacy), so
 * this subclasses the OpenAI adapter and only overrides the capability hooks.
 * Like the OpenAI adapter it runs statelessly: `store: false` +
 * `include: ["reasoning.encrypted_content"]`, with context replayed from
 * `messages` (override via `providerOptions`).
 *
 * Capability notes:
 * - `reasoning.effort` accepts `low`/`medium`/`high` (verified against
 *   grok-4.5); `none` is rejected (`reasoning_effort value none`), so reasoning
 *   cannot be disabled — the `reasoning` field is simply omitted instead.
 *   `xhigh`/`max` cap to `high`. No `summary` parameter is sent — xAI always
 *   returns detailed reasoning summaries for reasoning models.
 * - grok models accept `temperature`/`top_p` even when reasoning.
 * - xAI offers no embeddings API; `embed` throws `invalid_request`.
 * - `background` is never sent: xAI's Responses API rejects it (`Argument not
 *   supported: background`). The mechanism is OpenAI-only, so the auto-background
 *   behavior inherited from the OpenAI adapter is disabled here.
 */
export class XAIProvider extends OpenAIProvider {
  override readonly name: string = "xai";
  protected override readonly defaultBaseUrl: string = "https://api.x.ai";
  protected override readonly apiKeyEnv: string = "XAI_API_KEY";
  // xAI reports reasoning_tokens on top of output_tokens (total = input +
  // output + reasoning), unlike OpenAI where reasoning is a subset of output.
  protected override readonly reasoningIsAdditive: boolean = true;

  constructor(options: XAIProviderOptions = {}) {
    super(options);
  }

  protected override supportsSamplingParams(): boolean {
    return true;
  }

  /** xAI's Responses API rejects `background`; the mechanism is OpenAI-only. */
  protected override resolveBackground(): boolean {
    return false;
  }

  protected override convertReasoning(
    reasoning: NonNullable<GenerateOptions["reasoning"]>,
  ): Record<string, unknown> | undefined {
    // xAI reasoning models cannot disable reasoning (`effort: none` is
    // rejected), so omit the field entirely rather than try to turn it off.
    if (reasoning.enabled === false) return undefined;
    if (!reasoning.effort) return undefined;
    return { effort: EFFORT_MAP[reasoning.effort] };
  }

  protected override supportsWebSearch(model: string): boolean {
    return WEB_SEARCH_MODELS.test(model);
  }

  /**
   * xAI's `web_search` tool diverges from OpenAI's: domain filters live in
   * `filters` (capped at five, allowed/excluded mutually exclusive) and there
   * is no `search_context_size`/`user_location`.
   */
  protected override buildWebSearchTool(
    options: WebSearchOptions,
  ): Record<string, unknown> {
    const tool: Record<string, unknown> = { type: "web_search" };
    if (options.allowedDomains?.length) {
      tool.filters = {
        allowed_domains: options.allowedDomains.slice(0, MAX_SEARCH_DOMAINS),
      };
    } else if (options.blockedDomains?.length) {
      tool.filters = {
        excluded_domains: options.blockedDomains.slice(0, MAX_SEARCH_DOMAINS),
      };
    }
    return tool;
  }

  /** xAI also reports sources as a top-level `citations` list on the response. */
  protected override extractCitations(raw: OpenAIResponseBody): WebCitation[] {
    const citations = super.extractCitations(raw);
    const top = raw.citations;
    if (Array.isArray(top)) {
      for (const entry of top) {
        if (typeof entry === "string" && entry) {
          addCitations(citations, [{ url: entry }]);
        } else if (entry && typeof entry === "object") {
          const obj = entry as Record<string, unknown>;
          if (obj.url) {
            addCitations(citations, [
              {
                url: String(obj.url),
                ...(obj.title ? { title: String(obj.title) } : {}),
              },
            ]);
          }
        }
      }
    }
    return citations;
  }

  override embed(_options: EmbedOptions): Promise<EmbedResult> {
    return Promise.reject(
      new CardanError("invalid_request", "xAI does not offer an embeddings API", {
        provider: this.name,
      }),
    );
  }
}
