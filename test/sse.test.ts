import { test } from "node:test";
import assert from "node:assert/strict";

import { parseSse, type SseEvent } from "../src/sse.js";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of parseSse(streamOf(chunks))) events.push(event);
  return events;
}

test("parses events split across chunk boundaries", async () => {
  const events = await collect([
    "event: message_start\nda",
    'ta: {"a":1}\n\nevent: ping\ndata: {}\n\n',
  ]);
  assert.deepEqual(events, [
    { event: "message_start", data: '{"a":1}' },
    { event: "ping", data: "{}" },
  ]);
});

test("handles CRLF line endings and comments", async () => {
  const events = await collect([": keepalive\r\nevent: e\r\ndata: x\r\n\r\n"]);
  assert.deepEqual(events, [{ event: "e", data: "x" }]);
});

test("joins multiple data lines with newline", async () => {
  const events = await collect(["data: a\ndata: b\n\n"]);
  assert.deepEqual(events, [{ event: "", data: "a\nb" }]);
});

test("flushes a trailing event without final blank line", async () => {
  const events = await collect(["event: e\ndata: tail"]);
  assert.deepEqual(events, [{ event: "e", data: "tail" }]);
});

test("cancels the underlying body when the consumer breaks early", async () => {
  let cancelled = false;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("data: a\n\ndata: b\n\n"));
      // intentionally left open: the consumer breaks before completion
    },
    cancel() {
      cancelled = true;
    },
  });
  for await (const event of parseSse(body)) {
    assert.deepEqual(event, { event: "", data: "a" });
    break; // abandon the stream after the first event
  }
  assert.equal(cancelled, true);
});
