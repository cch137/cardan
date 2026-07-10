import { CardanError } from "./errors.js";
import type { ContentPart, Message, ToolCallPart, ToolResultPart } from "./types.js";

/**
 * Normalizes a message sequence into the canonical shape adapters rely on:
 *
 * - every tool_result is relocated into a `tool` message immediately after
 *   the assistant message containing its tool_call, in call order;
 * - dangling tool_calls (call without result) get a synthesized error
 *   result, so resumed/aborted conversations stay replayable;
 * - a tool_result without a matching tool_call throws (`invalid_request`),
 *   as does a duplicate result for the same call id;
 * - blank unsigned text parts are dropped (some providers, e.g. Anthropic,
 *   reject empty text blocks; a blank part carries no meaning for any of
 *   them). Signed text parts are kept — a signature must be replayed
 *   verbatim. A message left with no parts is dropped entirely;
 * - consecutive messages with the same role are merged.
 */
export function normalizeMessages(input: Message[]): Message[] {
  const messages: Message[] = input.map((message) => ({
    ...message,
    content: message.content.filter(
      (part) => !(part.type === "text" && !part.signature && !part.text.trim()),
    ),
  }));

  const results = new Map<string, ToolResultPart>();
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type !== "tool_result") continue;
      if (results.has(part.callId)) {
        throw new CardanError(
          "invalid_request",
          `duplicate tool_result for call id "${part.callId}"`,
        );
      }
      results.set(part.callId, part);
    }
  }

  const callIds = new Set<string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "tool_call") callIds.add(part.id);
    }
  }
  for (const callId of results.keys()) {
    if (!callIds.has(callId)) {
      throw new CardanError(
        "invalid_request",
        `tool_result references unknown call id "${callId}"`,
      );
    }
  }

  const out: Message[] = [];
  for (const message of messages) {
    const kept: ContentPart[] = message.content.filter(
      (part) => part.type !== "tool_result",
    );
    if (kept.length > 0 || message.content.length === 0) {
      out.push({ role: message.role, content: kept });
    }
    const calls = kept.filter((part): part is ToolCallPart => part.type === "tool_call");
    if (calls.length === 0) continue;
    const resultParts: ToolResultPart[] = calls.map(
      (call) =>
        results.get(call.id) ?? {
          type: "tool_result",
          callId: call.id,
          result: "tool call produced no result",
          isError: true,
        },
    );
    out.push({ role: "tool", content: resultParts });
  }

  return mergeConsecutive(out);
}

/** Joins the text parts of a content array (non-text parts are skipped). */
export function partsToText(parts: ContentPart[]): string {
  return parts
    .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/**
 * Splits leading system messages off into a single string (for providers
 * whose system prompt is a top-level parameter, not a message role).
 * Mid-conversation system messages are downgraded to user text; adjacent
 * same-role messages created by the downgrade are merged.
 */
export function splitLeadingSystem(messages: Message[]): {
  system?: string;
  messages: Message[];
} {
  const systemTexts: string[] = [];
  let index = 0;
  while (index < messages.length && messages[index]!.role === "system") {
    systemTexts.push(partsToText(messages[index]!.content));
    index++;
  }
  const rest: Message[] = [];
  for (const message of messages.slice(index)) {
    if (message.role === "system") {
      rest.push({
        role: "user",
        content: [{ type: "text", text: partsToText(message.content) }],
      });
    } else {
      rest.push(message);
    }
  }
  return {
    system: systemTexts.length > 0 ? systemTexts.join("\n\n") : undefined,
    messages: mergeConsecutive(rest),
  };
}

function mergeConsecutive(messages: Message[]): Message[] {
  const merged: Message[] = [];
  for (const message of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === message.role) {
      last.content = [...last.content, ...message.content];
    } else {
      merged.push({ role: message.role, content: [...message.content] });
    }
  }
  return merged.filter((message) => message.content.length > 0);
}
