export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Minimal SSE parser over a byte stream. Yields one event per blank-line
 * delimited block; multiple `data:` lines are joined with `\n`. Comment and
 * `id:`/`retry:` fields are ignored.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent, void, undefined> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];

  function* flush(): Generator<SseEvent> {
    if (dataLines.length > 0) {
      yield { event: eventName, data: dataLines.join("\n") };
    }
    eventName = "";
    dataLines = [];
  }

  function* consumeLine(line: string): Generator<SseEvent> {
    if (line === "") {
      yield* flush();
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        yield* consumeLine(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) yield* consumeLine(buffer.replace(/\r$/, ""));
    yield* flush();
  } finally {
    // cancel (not just releaseLock) so an early consumer break closes the
    // underlying fetch body instead of leaking the connection until GC;
    // a no-op on a stream that already completed or errored.
    await reader.cancel().catch(() => {});
  }
}
