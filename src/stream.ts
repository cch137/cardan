import {
  emptyUsage,
  type ContentPart,
  type FinishReason,
  type GenerateResult,
  type Message,
  type RateLimitStatus,
  type StreamEvent,
  type TextPart,
  type ThinkingPart,
  type WebCitation,
} from "./types.js";
import { partsToText } from "./normalize.js";

/**
 * Accumulates a stream into a GenerateResult-shaped value. Consecutive
 * deltas of the same kind collapse into one part; tool calls and thinking
 * signatures are attached in order.
 */
export async function collectStream(
  stream: AsyncIterable<StreamEvent>,
): Promise<Omit<GenerateResult, "raw">> {
  const content: ContentPart[] = [];
  let finishReason: FinishReason = "other";
  let usage = emptyUsage();
  let citations: WebCitation[] | undefined;
  let rateLimit: RateLimitStatus | undefined;

  const last = () => content[content.length - 1];

  for await (const event of stream) {
    switch (event.type) {
      case "text_delta": {
        const part = last();
        // a signed or cited text part is closed: never merge further deltas
        // into it, and never merge two separately signed parts together
        let target: TextPart;
        if (
          part?.type === "text" &&
          part.signature === undefined &&
          part.citations === undefined
        ) {
          part.text += event.text;
          target = part;
        } else {
          target = { type: "text", text: event.text };
          content.push(target);
        }
        if (event.signature !== undefined) target.signature = event.signature;
        break;
      }
      case "text_citations": {
        // pin the sources to the open text part (the claim they back); it is
        // now closed, so the next text_delta starts a fresh part
        const part = last();
        if (part?.type === "text" && part.citations === undefined) {
          part.citations = event.citations;
        } else {
          content.push({ type: "text", text: "", citations: event.citations });
        }
        break;
      }
      case "thinking_delta": {
        const part = last();
        let target: ThinkingPart;
        if (part?.type === "thinking" && part.signature === undefined) {
          part.text += event.text;
          target = part;
        } else {
          target = { type: "thinking", text: event.text };
          content.push(target);
        }
        if (event.signature !== undefined) target.signature = event.signature;
        break;
      }
      case "thinking_signature": {
        const part = last();
        if (part?.type === "thinking" && part.signature === undefined) {
          part.signature = event.signature;
          if (event.id !== undefined) part.id = event.id;
        } else {
          // no open thinking part (or it is already signed): a standalone
          // opaque block (Anthropic redacted_thinking, OpenAI summary-less
          // reasoning item)
          const thinking: ThinkingPart = {
            type: "thinking",
            text: "",
            signature: event.signature,
            ...(event.id !== undefined ? { id: event.id } : {}),
            redacted: true,
          };
          content.push(thinking);
        }
        break;
      }
      case "tool_call":
        content.push({
          type: "tool_call",
          id: event.id,
          name: event.name,
          args: event.args,
          ...(event.signature ? { signature: event.signature } : {}),
        });
        break;
      case "finish":
        finishReason = event.reason;
        usage = event.usage;
        if (event.citations?.length) citations = event.citations;
        if (event.rateLimit) rateLimit = event.rateLimit;
        break;
    }
  }

  return {
    message: { role: "assistant", content },
    text: partsToText(content),
    finishReason,
    usage,
    ...(citations ? { citations } : {}),
    ...(rateLimit ? { rateLimit } : {}),
  };
}

/**
 * Collects a stream into just the assistant `Message`, ready to push back into
 * the next request's `messages`. Replay-critical state (thinking signatures,
 * encrypted reasoning content, tool-call signatures) is preserved, so this is
 * the recommended way to capture a streamed turn for multi-turn replay — much
 * safer than reassembling a message from raw stream events by hand.
 */
export async function collectStreamToMessage(
  stream: AsyncIterable<StreamEvent>,
): Promise<Message> {
  return (await collectStream(stream)).message;
}
