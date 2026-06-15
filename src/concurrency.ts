/**
 * Concurrency-limited parallel map. Runs `fn` over `items` with at most
 * `concurrency` tasks in flight at once (default: unlimited), preserving input
 * order in the result. Fail-fast: the first rejection rejects the whole call
 * (already-running tasks are left to settle). The `signal` is checked before
 * each task starts *and* forwarded to `fn` as its third argument, so the work
 * itself (e.g. a `conversation.ask`) can be cancelled mid-flight — pass it on.
 *
 * This is the recommended way to fan work out *inside* a single workflow node
 * (e.g. research N items concurrently), as opposed to graph-level fan-out.
 */
export async function parallel<T, R>(
  items: readonly T[],
  fn: (item: T, index: number, signal?: AbortSignal) => R | Promise<R>,
  options: { concurrency?: number; signal?: AbortSignal } = {},
): Promise<R[]> {
  const { concurrency = Infinity, signal } = options;
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const i = next++;
      results[i] = await fn(items[i] as T, i, signal);
    }
  };

  const limit = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}
