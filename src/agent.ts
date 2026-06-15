// Glue between the (LLM-agnostic) flow runner and the conversation layer. This
// is the only module that knows about both: `flow.ts` never imports
// conversations, and `conversation.ts` never imports the flow.

import type { FlowCtx } from "./flow.js";
import type { CallInfo, Conversation, ConversationOptions } from "./conversation.js";

/** Anything that can mint a {@link Conversation} — a `Cardan` instance satisfies
 *  this structurally, so no concrete import is needed. */
export interface ConversationFactory {
  conversation(options: ConversationOptions): Conversation;
}

/** The context fields {@link withConversations} adds to every step. */
export interface ConversationContext {
  /** Start a {@link Conversation} whose per-call telemetry is forwarded to the
   *  flow's event stream, tagged with the current step. */
  conversation(options: ConversationOptions): Conversation;
}

/**
 * An `extendCtx` builder: pass it to `createFlow(...)({ extendCtx })` and every
 * step gains `ctx.conversation(...)`. Conversations it creates report each LLM
 * call as a `{ type: "llm", name, iteration, call }` flow event (any `onCall`
 * you also pass still runs). Use `fork()` on the returned conversation before
 * fanning out in parallel so branches don't share a mutable transcript.
 */
export function withConversations(
  factory: ConversationFactory,
): (base: FlowCtx) => ConversationContext {
  return (base) => ({
    conversation(options) {
      const userOnCall = options.onCall;
      return factory.conversation({
        ...options,
        onCall: (call: CallInfo) => {
          userOnCall?.(call);
          base.emit({ type: "llm", name: base.name, iteration: base.iteration, call });
        },
      });
    },
  });
}
