import {
  emptyUsage,
  type ContentPart,
  type FinishReason,
  type GenerateResult,
  type StreamEvent,
  type ThinkingPart,
} from "./types.js";

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

  const last = () => content[content.length - 1];

  for await (const event of stream) {
    switch (event.type) {
      case "text_delta": {
        const part = last();
        if (part?.type === "text") part.text += event.text;
        else content.push({ type: "text", text: event.text });
        break;
      }
      case "thinking_delta": {
        const part = last();
        if (part?.type === "thinking" && part.signature === undefined) {
          part.text += event.text;
        } else {
          content.push({ type: "thinking", text: event.text });
        }
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
        break;
    }
  }

  return {
    message: { role: "assistant", content },
    finishReason,
    usage,
  };
}
