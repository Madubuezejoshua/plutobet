import type { InngestFunction } from "inngest";

/**
 * Runs registered Inngest functions in-process, faithfully enough to test them.
 *
 * WHY THIS EXISTS AND WHAT IT IS NOT
 * The settlement chain was only ever proven by calling its services directly,
 * which skips the registered function entirely — the part that had never
 * actually run. Testing the services proved the logic; it did not prove the
 * entry point wires them together.
 *
 * This drives `InngestFunction.fn`, the real handler, with a `step`
 * implementation modelling Inngest's own semantics:
 *
 *   step.run(id, fn)        -> await fn()          (memoised per run, as Inngest does)
 *   step.sendEvent(id, ev)  -> dispatch to whichever registered function
 *                              declares that event as its trigger
 *
 * WHAT IT DELIBERATELY DOES NOT MODEL: durability, retries, backoff, or
 * cross-invocation memoisation. Those belong to the platform, and a test that
 * pretended to cover them would assert something this harness cannot know.
 * What it does prove is that the registered handler, its steps, the events it
 * emits and the functions those events reach form a working chain.
 */

type StepRunner = {
  run<T>(id: string, fn: () => Promise<T> | T): Promise<T>;
  sendEvent(id: string, events: unknown): Promise<void>;
};

interface DispatchedEvent {
  name: string;
  data: Record<string, unknown>;
  id?: string;
}

export interface RunRecord {
  /** Every step id executed, in order — proves the chain actually ran. */
  steps: string[];
  /** Every event dispatched, including ones with no listener. */
  events: DispatchedEvent[];
  /** What each function returned, keyed by function id. */
  returns: Record<string, unknown>;
}

function asEvents(payload: unknown): DispatchedEvent[] {
  const list = Array.isArray(payload) ? payload : [payload];
  return list.filter((e): e is DispatchedEvent => Boolean(e) && typeof e === "object");
}

/**
 * Executes `entry`, following every event it emits into the other functions.
 *
 * `registry` is the same list the serve route registers, so a function missing
 * from the route is missing here too — the test fails for the same reason
 * production would.
 */
export async function runScheduledFunction(
  entry: InngestFunction.Any,
  registry: InngestFunction.Any[],
  triggerEvent: Record<string, unknown> = {},
): Promise<RunRecord> {
  const record: RunRecord = { steps: [], events: [], returns: {} };

  const invoke = async (fn: InngestFunction.Any, event: Record<string, unknown>): Promise<void> => {
    const id = String((fn as unknown as { opts: { id: string } }).opts.id);
    // Inngest memoises a step id within one run; two steps sharing an id in
    // the same invocation would otherwise silently run twice here and not
    // in production.
    const seen = new Map<string, unknown>();

    const step: StepRunner = {
      async run(stepId, body) {
        record.steps.push(`${id}:${stepId}`);
        if (seen.has(stepId)) return seen.get(stepId) as never;
        const value = await body();
        seen.set(stepId, value);
        return value;
      },
      async sendEvent(_stepId, payload) {
        for (const dispatched of asEvents(payload)) {
          record.events.push(dispatched);
          const listeners = registry.filter((candidate) =>
            triggersOf(candidate).some((t) => t.event === dispatched.name),
          );
          for (const listener of listeners) {
            await invoke(listener, { name: dispatched.name, data: dispatched.data });
          }
        }
      },
    };

    const handler = (fn as unknown as { fn: (ctx: unknown) => Promise<unknown> }).fn;
    record.returns[id] = await handler({ step, event, events: [event], runId: `test-${id}` });
  };

  await invoke(entry, triggerEvent);
  return record;
}

/**
 * Inngest normalises  to an ARRAY, even when one was configured as a
 * bare object. Reading it as an object silently yields undefined, which is how
 * the first version of this harness reported "no cron registered" for a
 * function that plainly had one.
 */
function triggersOf(fn: InngestFunction.Any): { cron?: string; event?: string }[] {
  const raw = (fn as unknown as { opts: { triggers?: unknown } }).opts.triggers;
  return Array.isArray(raw) ? (raw as { cron?: string; event?: string }[]) : [];
}

/** The cron expression a function is registered with, or null if not a cron. */
export function cronOf(fn: InngestFunction.Any): string | null {
  return triggersOf(fn).find((t) => t.cron)?.cron ?? null;
}
