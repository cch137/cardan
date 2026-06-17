import { CardanError } from "./errors.js";
import type { Infer, SchemaInput } from "./schema.js";
import type {
  FinishReason,
  GenerateOptions,
  GenerateResult,
  Message,
  Tool,
  ToolResultPart,
  Usage,
} from "./types.js";
import { emptyUsage } from "./types.js";
import type { ModelId } from "./index.js";

/**
 * The slice of {@link Cardan} a conversation drives. Any `provider/model`
 * router with a `generate` is enough; `Cardan` satisfies it structurally.
 */
export interface ConversationClient {
  generate(
    options: Omit<GenerateOptions, "model"> & { model: ModelId },
  ): Promise<GenerateResult>;
}

/** Per-call telemetry, emitted once per `generate` (success or failure). The
 *  consumer decides how to format/route it — cardan itself logs nothing. */
export interface CallInfo {
  /** `label` or `label/step`, for log prefixes. */
  tag?: string;
  model: ModelId;
  /** Wall-clock duration in milliseconds. */
  ms: number;
  usage: Usage;
  /** Number of web-search citations gathered this call. */
  citations: number;
  /** Present on success. */
  finishReason?: FinishReason;
  /** Present on failure (the thrown value). */
  error?: unknown;
}

/** Per-turn options. Every key is a default the conversation can carry (set at
 *  construction or reassigned on `defaults`) and override per `ask`; none is
 *  privileged — `model` and `tools` are merged the same way. */
export interface AskOptions<S extends SchemaInput = SchemaInput>
  extends Omit<GenerateOptions<S>, "model" | "messages" | "tools"> {
  /** `provider/model`; overrides the conversation default for this turn. */
  model?: ModelId;
  /** Client-side tools; when present, `ask` loops model↔tools until it stops. */
  tools?: ToolHandler[];
  /** Max model↔tool round-trips before forcing a tool-free conclusion. */
  maxRounds?: number;
  /** After the tool loop, rewrite the round-trips it appended so their bulky raw
   *  tool outputs aren't replayed on later turns. `true` uses the default
   *  {@link redactToolResults} compactor (keeps the tool-use trace, blanks the
   *  result payloads); pass your own {@link Compactor} to customize (e.g.
   *  {@link dropToolRounds}, or an LLM summary). */
  compact?: boolean | Compactor;
  /** Phase tag for per-call telemetry (e.g. "research", "structure"). */
  step?: string;
}

export interface ConversationOptions extends AskOptions {
  /** Default `provider/model` for every turn; required at construction. */
  model: ModelId;
  /** Optional system prompt, prepended as the first turn. */
  system?: string;
  /** Purpose tag for per-call telemetry (e.g. "screen", "investigate <id>"). */
  label?: string;
  /** Telemetry sink invoked once per `generate`. */
  onCall?(info: CallInfo): void;
}

/** A client-side tool: its cardan declaration plus a handler that runs when the
 *  model calls it. `run` returns the text result fed back to the model. Prefer
 *  {@link defineTool} so `args` is typed from the schema. */
export interface ToolHandler {
  tool: Tool;
  run(args: unknown, signal?: AbortSignal): string | Promise<string>;
}

/** Build a {@link ToolHandler} whose `run` receives args typed from `parameters`
 *  (a zod schema infers the type; a plain JSON Schema yields `unknown`). */
export function defineTool<S extends SchemaInput>(
  spec: { name: string; description?: string; parameters: S },
  run: (args: Infer<S>, signal?: AbortSignal) => string | Promise<string>,
): ToolHandler {
  return { tool: spec, run: run as ToolHandler["run"] };
}

/** Rewrites the region a tool loop appended after this turn's user prompt — the
 *  assistant tool-call rounds, the tool results, and the final tool-free
 *  conclusion — into a shorter replacement spliced back in its place. Keep any
 *  `tool_call` paired with its `tool_result` (or rely on message normalization
 *  to backfill a result) so the transcript stays replayable. */
export type Compactor = (region: Message[]) => Message[];

const REDACTED_TOOL_RESULT = "[tool result omitted to save context]";

/** Default compactor: keep the whole tool-use trace (the calls and the final
 *  conclusion) but replace each tool result's payload with a short placeholder.
 *  The model still sees that it reached the conclusion *by using tools* — only
 *  the bulky raw bodies (page text, etc.) are shed — so later turns won't
 *  mistake the conclusion for innate knowledge, and raw content can't trip
 *  provider content filters on replay. */
export const redactToolResults: Compactor = (region) =>
  region.map((message) =>
    message.role === "tool"
      ? {
          role: "tool",
          content: message.content.map((part) =>
            part.type === "tool_result"
              ? { ...part, result: REDACTED_TOOL_RESULT }
              : part,
          ),
        }
      : message,
  );

/** Aggressive compactor: drop the tool-use trace entirely, keeping only the
 *  model's final conclusion. Smallest transcript, but later turns can no longer
 *  tell the conclusion came from tool use. */
export const dropToolRounds: Compactor = (region) => region.slice(-1);

/** A running transcript over a {@link ConversationClient}: hold the message
 *  history and collapse the repeated "push user → generate → push assistant"
 *  dance into one call. Multi-step workflows read cleanly:
 *
 *   const c = cardan.conversation({ model });
 *   await c.ask("research …", { webSearch: true, tools, compact: true });
 *   const { output } = await c.ask("emit JSON …", { output: { schema } });
 */
export class Conversation {
  /** Full transcript, mutated in place across turns (replayable to the model). */
  readonly messages: Message[] = [];
  /** Generation defaults carried across turns; each `ask` merges call options
   *  over these. Reassign any key (e.g. `defaults.model`) to change it for all
   *  later turns. */
  defaults: AskOptions;
  /** Purpose tag for per-call telemetry; reassignable. */
  label?: string;

  private readonly client: ConversationClient;
  private readonly onCall?: (info: CallInfo) => void;

  constructor(client: ConversationClient, options: ConversationOptions) {
    const { system, label, onCall, ...defaults } = options;
    this.client = client;
    this.defaults = defaults;
    this.label = label;
    this.onCall = onCall;
    if (system) {
      this.messages.push({ role: "system", content: [{ type: "text", text: system }] });
    }
  }

  /** Branch this conversation: a new `Conversation` sharing the same client and
   *  defaults but with an independent copy of the transcript. Diverging turns on
   *  the fork never touch this one — use it before fanning out in parallel so
   *  branches don't mutate a shared `messages` array. `overrides` tweak the
   *  fork's defaults/label/onCall (a `system` override is ignored, since the copy
   *  already carries the original system turn). */
  fork(overrides: Partial<ConversationOptions> = {}): Conversation {
    const { system: _system, ...rest } = overrides;
    const clone = new Conversation(this.client, {
      ...this.defaults,
      label: this.label,
      onCall: this.onCall,
      ...rest,
    } as ConversationOptions);
    clone.messages.push(...this.messages);
    return clone;
  }

  /** Append a user text turn, generate, append the assistant reply, return it.
   *  When `options.tools` are present, loop model↔tools until the model stops
   *  (optionally compacting the intermediate rounds afterwards). */
  async ask<S extends SchemaInput = SchemaInput>(
    text: string,
    options: AskOptions<S> = {},
  ): Promise<GenerateResult<Infer<S>>> {
    const { tools, maxRounds, compact, step, ...gen } = {
      ...this.defaults,
      ...options,
    };
    // Structured output is constrained decoding; every provider implements it as
    // response_format / responseSchema, which forbids the model from emitting a
    // tool call. Combining the two in one turn silently starves the tool loop, so
    // reject it: run the tool loop first, then ask again with `output`.
    if (tools?.length && gen.output) {
      throw new CardanError(
        "invalid_request",
        "ask cannot combine `tools` with `output`: structured output blocks " +
          "tool calls. Run the tool loop first, then ask again with `output`.",
      );
    }
    this.messages.push({ role: "user", content: [{ type: "text", text }] });
    if (!tools?.length) {
      return this.generateOnce(gen, step) as Promise<GenerateResult<Infer<S>>>;
    }

    const mark = this.messages.length; // first message after the user prompt
    const res = await this.runToolLoop(tools, gen, step, maxRounds);
    if (compact) {
      const compactor = compact === true ? redactToolResults : compact;
      const region = this.messages.slice(mark); // tool rounds + final conclusion
      this.messages.splice(mark, region.length, ...compactor(region));
    }
    return res as GenerateResult<Infer<S>>;
  }

  /** Generate against the current transcript and append the reply. No new user
   *  turn is added. `gen` holds the merged per-turn options; `rawTools` are the
   *  cardan tool declarations for this call (none for a plain turn). */
  private async generateOnce(
    gen: Omit<AskOptions, "tools" | "maxRounds" | "compact" | "step">,
    step: string | undefined,
    rawTools?: Tool[],
  ): Promise<GenerateResult> {
    const model = gen.model ?? this.defaults.model;
    if (!model) {
      throw new CardanError("invalid_request", "no model set for this turn");
    }
    const tag = this.label && step
      ? `${this.label}/${step}`
      : step ?? this.label;
    const t0 = Date.now();
    try {
      const res = await this.client.generate({
        ...gen,
        model,
        messages: this.messages,
        tools: rawTools,
      });
      this.messages.push(res.message);
      this.onCall?.({
        tag,
        model,
        ms: Date.now() - t0,
        usage: res.usage,
        citations: res.citations?.length ?? 0,
        finishReason: res.finishReason,
      });
      return res;
    } catch (error) {
      this.onCall?.({
        tag,
        model,
        ms: Date.now() - t0,
        usage: emptyUsage(),
        citations: 0,
        error,
      });
      throw error;
    }
  }

  /** Loop: generate → run any tool calls → feed results back, until the model
   *  stops calling tools. The final round (at maxRounds) forbids tools so the
   *  model must produce a prose conclusion — guaranteeing the last message
   *  carries no dangling tool call. */
  private async runToolLoop(
    handlers: ToolHandler[],
    gen: Omit<AskOptions, "tools" | "maxRounds" | "compact" | "step">,
    step: string | undefined,
    maxRounds: number | undefined,
  ): Promise<GenerateResult> {
    const byName = new Map(handlers.map((h) => [h.tool.name, h]));
    const tools = handlers.map((h) => h.tool);
    const max = maxRounds ?? 8;

    for (let round = 0; ; round++) {
      const last = round >= max;
      const res = await this.generateOnce(
        { ...gen, toolChoice: last ? "none" : "auto" },
        step,
        tools,
      );
      if (last || res.finishReason !== "tool_calls") return res;

      const results: ToolResultPart[] = [];
      for (const part of res.message.content) {
        if (part.type !== "tool_call") continue;
        const handler = byName.get(part.name);
        try {
          if (!handler) throw new Error(`unknown tool ${part.name}`);
          const out = await handler.run(part.args, gen.signal);
          results.push({ type: "tool_result", callId: part.id, result: out });
        } catch (err) {
          results.push({
            type: "tool_result",
            callId: part.id,
            result: err instanceof Error ? err.message : String(err),
            isError: true,
          });
        }
      }
      this.messages.push({ role: "tool", content: results });
    }
  }
}
