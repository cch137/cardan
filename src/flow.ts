// A tiny flow runner: drive a set of mutually-referencing async steps over a
// shared typed state. A step returns its state update and — via `goto` — what
// to run next, so control flow (branching, loops, fan-out) lives in the steps
// themselves rather than a separate graph. There is no edge table and no
// terminal marker: a step that returns without a `goto` simply ends its branch.
//
// Parallelism is deterministic by superstep: steps scheduled together run on
// the same state snapshot and their patches merge at a barrier via `reducers`
// (a key written by two steps at once needs one, or the merge throws). Steps
// that route to the same function converge into a single run (join).

/** Context passed to every step. Extend it with `extendCtx` (see `FlowConfig`). */
export interface FlowCtx {
  /** The running step's function name ("(anonymous)" if it has none). */
  name: string;
  /** Zero-based superstep index. */
  iteration: number;
  signal?: AbortSignal;
  /** Emit a progress event to the run's `onEvent` sink (no-op if none). */
  emit(event: FlowEvent): void;
}

/** Progress event. Core types are `step:start` / `step:end` / `error`;
 *  `extendCtx` integrations may emit their own (e.g. `"llm"`). */
export interface FlowEvent {
  type: string;
  name?: string;
  iteration?: number;
  [key: string]: unknown;
}

const GOTO: unique symbol = Symbol("cardan.flow.goto");

export interface Goto<S, X> {
  /** Step(s) to run next; an array fans out (the steps run in parallel). */
  next: Step<S, X> | Step<S, X>[];
  /** State patch to apply before continuing. */
  update?: Partial<S>;
}

type BrandedGoto<S, X> = Goto<S, X> & { readonly [GOTO]: true };

/** Continue the flow: run `next` after applying `update`. Returning this from a
 *  step is the only way to keep going — omit it to end the branch. */
export function goto<S, X = unknown>(
  next: Step<S, X> | Step<S, X>[],
  update?: Partial<S>,
): BrandedGoto<S, X> {
  return { next, update, [GOTO]: true };
}

function isGoto<S, X>(value: unknown): value is BrandedGoto<S, X> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[GOTO] === true
  );
}

/** What a step returns: a state patch (and end the branch), nothing (end the
 *  branch), or a {@link goto} to continue. */
export type StepResult<S, X> = void | Partial<S> | BrandedGoto<S, X>;

/** A step: reads the current state snapshot, returns a patch and/or a `goto`. */
export type Step<S, X = unknown> = (
  state: S,
  ctx: FlowCtx & X,
) => StepResult<S, X> | Promise<StepResult<S, X>>;

/** Thrown for runner-level failures: undeclared concurrent writes, exceeding
 *  `maxSteps`, or abort. */
export class FlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowError";
  }
}

export interface FlowConfig<S, X = unknown> {
  /** Merge functions for state keys written by more than one parallel step, or
   *  for accumulating keys (e.g. append). Keys without a reducer overwrite;
   *  concurrent writes to such a key throw. */
  reducers?: { [K in keyof S]?: (current: S[K], incoming: S[K]) => S[K] };
  /** Cap on supersteps; exceeding it throws (guards non-terminating loops).
   *  Default 25. */
  maxSteps?: number;
  /** Build extra per-step context fields (merged into `ctx`). The runner never
   *  inspects them — this is the seam LLM glue uses to add `ctx.conversation`. */
  extendCtx?: (base: FlowCtx) => X;
}

export interface RunOptions {
  signal?: AbortSignal;
  onEvent?(event: FlowEvent): void;
}

const DEFAULT_MAX_STEPS = 25;

type Reducers = Record<string, ((current: unknown, incoming: unknown) => unknown) | undefined>;
type Outcome<S, X> = { step: Step<S, X>; result: StepResult<S, X> };

/** A runner bound to a state shape and (optional) reducers / context extension.
 *  Reusable across `run` calls — state lives in the argument, not the instance. */
export class Flow<S, X = unknown> {
  constructor(private readonly config: FlowConfig<S, X> = {}) {}

  async run(entry: Step<S, X>, initial: S, options: RunOptions = {}): Promise<S> {
    const { signal, onEvent } = options;
    const emit = (event: FlowEvent): void => onEvent?.(event);
    const maxSteps = this.config.maxSteps ?? DEFAULT_MAX_STEPS;
    const reducers = (this.config.reducers ?? {}) as Reducers;

    // Steps in a superstep run fail-fast: the first to throw rejects the run. We
    // expose that through `failure` so the *siblings* still in flight observe it
    // via `ctx.signal` (and the conversations / `parallel()` they spawned can
    // cancel) instead of running on uselessly. `failure` also folds in the
    // caller's `signal`, so steps honor a single composed abort.
    const failure = new AbortController();
    const onAbort = () => failure.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) failure.abort(signal.reason);
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const stepSignal = failure.signal;

    let state = initial;
    let frontier: Step<S, X>[] = [entry];

    try {
      for (let iteration = 0; frontier.length > 0; iteration++) {
        if (stepSignal.aborted) throw stepSignal.reason ?? new FlowError("aborted");
        if (iteration >= maxSteps) {
          throw new FlowError(
            `flow exceeded maxSteps (${maxSteps}); check for a non-terminating loop`,
          );
        }
        const snapshot = state; // every step this superstep reads the same snapshot
        const outcomes = await Promise.all(
          frontier.map((step) =>
            this.runStep(step, snapshot, iteration, stepSignal, emit).catch(
              (error: unknown) => {
                failure.abort(error); // wake the siblings before unwinding
                throw error;
              },
            ),
          ),
        );
        state = this.merge(snapshot, outcomes, reducers);
        frontier = this.nextFrontier(outcomes);
      }
      return state;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async runStep(
    step: Step<S, X>,
    snapshot: S,
    iteration: number,
    signal: AbortSignal,
    emit: (event: FlowEvent) => void,
  ): Promise<Outcome<S, X>> {
    const name = step.name || "(anonymous)";
    const base: FlowCtx = { name, iteration, signal, emit };
    const ctx = (this.config.extendCtx
      ? Object.assign(base, this.config.extendCtx(base))
      : base) as FlowCtx & X;
    emit({ type: "step:start", name, iteration });
    const t0 = Date.now();
    try {
      const result = await step(snapshot, ctx);
      emit({ type: "step:end", name, iteration, ms: Date.now() - t0 });
      return { step, result };
    } catch (error) {
      emit({ type: "error", name, iteration, error });
      throw error;
    }
  }

  private merge(snapshot: S, outcomes: Outcome<S, X>[], reducers: Reducers): S {
    const patches: Partial<S>[] = [];
    const writers = new Map<string, string[]>();
    for (const { step, result } of outcomes) {
      const update = isGoto<S, X>(result) ? result.update : (result || undefined);
      if (!update) continue;
      patches.push(update);
      const name = step.name || "(anonymous)";
      for (const key of Object.keys(update)) {
        const seen = writers.get(key);
        if (seen) seen.push(name);
        else writers.set(key, [name]);
      }
    }
    if (patches.length === 0) return snapshot;

    for (const [key, names] of writers) {
      if (names.length > 1 && !reducers[key]) {
        throw new FlowError(
          `concurrent writes to "${key}" by [${names.join(", ")}] need a reducer`,
        );
      }
    }

    const next = { ...snapshot } as Record<string, unknown>;
    for (const update of patches) {
      for (const [key, value] of Object.entries(update)) {
        const reducer = reducers[key];
        next[key] = reducer ? reducer(next[key], value) : value;
      }
    }
    return next as S;
  }

  private nextFrontier(outcomes: Outcome<S, X>[]): Step<S, X>[] {
    const frontier: Step<S, X>[] = [];
    const seen = new Set<Step<S, X>>();
    for (const { result } of outcomes) {
      if (!isGoto<S, X>(result)) continue;
      const next = Array.isArray(result.next) ? result.next : [result.next];
      for (const step of next) {
        if (!seen.has(step)) {
          seen.add(step);
          frontier.push(step);
        }
      }
    }
    return frontier;
  }
}

/** Create a flow runner. Curried so `S` is given explicitly while the context
 *  extension `X` infers from `config.extendCtx`:
 *
 *   const flow = createFlow<MyState>()({ reducers });
 *   const final = await flow.run(entryStep, initialState);
 */
export function createFlow<S>() {
  return <X = unknown>(config: FlowConfig<S, X> = {}): Flow<S, X> => new Flow<S, X>(config);
}
