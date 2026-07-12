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

/**
 * Names of all environment variables visible to this process (Node
 * `process.env` keys, or Deno `Deno.env.toObject()`). Empty when unavailable.
 */
export function listEnvNames(): string[] {
  const g = globalThis as {
    process?: { env?: Record<string, string | undefined> };
    Deno?: { env?: { toObject(): Record<string, string> } };
  };
  if (g.process?.env) return Object.keys(g.process.env);
  try {
    return Object.keys(g.Deno?.env?.toObject() ?? {});
  } catch {
    return [];
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Expand a base env name to every **set** sibling in the environment:
 * exact `BASE`, plus `BASE1`, `BASE2`, … `BASE10`, … (one or more trailing
 * digits). Order: bare first, then by numeric suffix ascending.
 *
 * Used so multi-account pools don't hard-code `TOKEN1`/`TOKEN2` — set as many
 * numbered vars as you need.
 */
export function expandEnvFamily(
  base: string,
  names: readonly string[] = listEnvNames(),
): string[] {
  if (!base) return [];
  const re = new RegExp(`^${escapeRegExp(base)}(\\d+)?$`);
  const matched: Array<{ name: string; n: number }> = [];
  for (const name of names) {
    const m = re.exec(name);
    if (!m) continue;
    const value = readEnv(name)?.trim();
    if (!value) continue;
    matched.push({ name, n: m[1] === undefined ? 0 : Number(m[1]) });
  }
  matched.sort((a, b) => a.n - b.n || a.name.localeCompare(b.name));
  return matched.map((x) => x.name);
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
