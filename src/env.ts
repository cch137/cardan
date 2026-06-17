/**
 * Reads an environment variable on Node (`process.env`) or Deno
 * (`Deno.env`), without depending on either runtime's types or APIs.
 * Returns undefined when unavailable (e.g. permission-restricted Deno).
 */
export function readEnv(name: string): string | undefined {
  const g = globalThis as {
    process?: { env?: Record<string, string | undefined> };
    Deno?: { env?: { get(name: string): string | undefined } };
  };
  const fromProcess = g.process?.env?.[name];
  if (fromProcess) return fromProcess;
  try {
    return g.Deno?.env?.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

const warned = new Set<string>();

/**
 * Emits a `console.warn` for ambiguous-configuration cases, at most once per
 * `key` per process so repeated requests don't spam the log.
 */
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[cardan] ${message}`);
}
