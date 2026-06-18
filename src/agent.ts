// Agent: a reusable identity (name / system / model / tools) plus optional
// cross-session memory, layered over Conversation. The agent holds no runtime of
// its own — `run` and `conversation()` build a Conversation and let it do the
// work. This is the only seam between the identity layer and Conversation;
// conversation.ts stays unaware of agents.

import { CardanError } from "./errors.js";
import {
  Conversation,
  type AskOptions,
  type CallInfo,
  type ConversationClient,
  type ConversationOptions,
  type ToolHandler,
} from "./conversation.js";
import { addUsage, emptyUsage, type GenerateResult } from "./types.js";
import type { ModelId } from "./index.js";

/**
 * Cross-session memory for an {@link Agent} — what it carries *between*
 * conversations (a transcript is within one). cardan only decides *when* to call
 * these (recall before a run, observe after); where and how to store, and whether
 * to summarize, is the caller's implementation. Not a vector store.
 */
export interface Memory {
  /** Text appended to the system prompt before a run. */
  recall(): string | Promise<string>;
  /** Update memory after a completed run, given its result. */
  observe(result: GenerateResult): void | Promise<void>;
}

/** An agent's fixed identity. Pass to {@link Cardan.agent}. */
export interface AgentSpec {
  /** Identity label; used as the conversation's telemetry tag. */
  name: string;
  system?: string;
  /** Default model; may be omitted only if every `run`/`conversation` passes one. */
  model?: ModelId;
  /** Client-side tools the agent may call (auto tool-loop in `run`). */
  tools?: ToolHandler[];
  memory?: Memory;
  /** Telemetry sink forwarded to every conversation the agent starts. */
  onCall?(info: CallInfo): void;
}

export class Agent {
  constructor(
    private readonly client: ConversationClient,
    readonly spec: AgentSpec,
  ) {}

  /**
   * Start a fresh {@link Conversation} pre-configured with this agent's identity,
   * for callers who drive the turns themselves (mid-run / conditional steering).
   * Does **not** apply `memory`: under manual driving the observe timing is
   * undefined — use {@link run} for the recall→act→observe loop, or inject memory
   * into `system` yourself.
   */
  conversation(options: AskOptions = {}): Conversation {
    return new Conversation(this.client, this.buildOptions(options));
  }

  /**
   * Run one closed task: recall memory → `ask` (auto tool-loop if the agent has
   * tools) → observe → return. The returned result's `usage` is the
   * **accumulated** total across every generate this run made (tool-loop rounds
   * included), not just the last turn — so reading it gives the task's full cost.
   */
  async run(input: string, options: AskOptions = {}): Promise<GenerateResult> {
    const memorySystem = await this.spec.memory?.recall();
    const total = emptyUsage();
    const userOnCall = this.spec.onCall;
    const conversation = new Conversation(
      this.client,
      this.buildOptions(options, memorySystem, (info) => {
        addUsage(total, info.usage);
        userOnCall?.(info);
      }),
    );
    // `options` were already folded into the conversation's defaults by
    // buildOptions, so ask inherits them — don't pass them a second time.
    const result = await conversation.ask(input);
    const accumulated: GenerateResult = { ...result, usage: total };
    await this.spec.memory?.observe(accumulated);
    return accumulated;
  }

  /** Resolve ConversationOptions from the spec: model (per-call override wins),
   *  system (+ recalled memory), tools, telemetry tag, and onCall sink. */
  private buildOptions(
    options: AskOptions,
    extraSystem?: string,
    onCall?: (info: CallInfo) => void,
  ): ConversationOptions {
    const model = options.model ?? this.spec.model;
    if (!model) {
      throw new CardanError(
        "invalid_request",
        `agent "${this.spec.name}" has no model: set spec.model or pass one per call`,
      );
    }
    return {
      ...options,
      model,
      system: joinSystem(this.spec.system, extraSystem),
      tools: options.tools ?? this.spec.tools,
      label: this.spec.name,
      onCall: onCall ?? this.spec.onCall,
    };
  }
}

function joinSystem(base?: string, extra?: string): string | undefined {
  if (base && extra) return `${base}\n\n${extra}`;
  return base ?? extra;
}
