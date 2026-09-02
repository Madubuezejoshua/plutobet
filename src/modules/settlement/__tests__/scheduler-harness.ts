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
  /**
   * Failures inside a triggered function.
   *
   * Kept separate from the sender's own outcome because Inngest keeps them
   * separate: accepting an event succeeds even when the function it triggers
   * later fails.
   */
  listenerErrors: { event: string; message: string }[];
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
  const record: RunRecord = { steps: [], events: [], returns: {}, listenerErrors: [] };

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
            /*
             * A listener's failure must NOT propagate into the sender.
             *
             * Inngest accepts the event and runs the triggered function
             * independently, retrying it on its own schedule; the sender is
             * finished once the message is accepted. Letting the exception
             * escape here modelled something the platform does not do, and
             * turned one unsettleable event into a failure of the whole
             * dispatch batch — a failure mode that exists only in this
             * harness, which is the worst kind to test against.
             *
             * Recorded rather than swallowed, so a test can still assert that
             * a listener failed.
             */
            try {
              await invoke(listener, { name: dispatched.name, data: dispatched.data });
            } catch (error) {
              record.listenerErrors.push({
                event: dispatched.name,
                message: error instanceof Error ? error.message : String(error),
              });
            }
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

/**
 * Replays a function the way Inngest actually executes it.
 *
 * THIS IS THE ONE THE ORIGINAL HARNESS COULD NOT CATCH. `runScheduledFunction`
 * memoises steps within a SINGLE invocation, which models one HTTP call. Inngest
 * does not work that way: it invokes the handler once per step, replaying the
 * function from the top each time and serving completed steps from a
 * checkpoint. Code OUTSIDE a step therefore re-executes on every invocation.
 *
 * That difference destroyed a real customer's payout. The cadence claim — a
 * one-winner `SET NX` — sat outside `step.run`, so the second invocation found
 * the claim held by its own first invocation, returned "not due", and never
 * reached the dispatch. Every service-level test passed; so did a
 * single-invocation harness test.
 *
 * Here the memo map lives OUTSIDE the invocation loop, so a step executed in
 * invocation 1 is replayed from the checkpoint in invocation 2, and anything
 * outside a step runs again — exactly as in production.
 *
 * `maxInvocations` bounds it: a handler that never converges is a bug, not a
 * reason to loop forever.
 */
export async function replayScheduledFunction(
  entry: InngestFunction.Any,
  registry: InngestFunction.Any[],
  triggerEvent: Record<string, unknown> = {},
  maxInvocations = 6,
): Promise<RunRecord & { invocations: number }> {
  const record: RunRecord = { steps: [], events: [], returns: {}, listenerErrors: [] };
  // Survives across invocations. This is the whole point.
  const memo = new Map<string, unknown>();
  let invocations = 0;

  const id = String((entry as unknown as { opts: { id: string } }).opts.id);
  const handler = (entry as unknown as { fn: (ctx: unknown) => Promise<unknown> }).fn;

  for (let attempt = 0; attempt < maxInvocations; attempt += 1) {
    invocations += 1;
    let ranNewStep = false;

    const step: StepRunner = {
      async run(stepId, body) {
        const key = `${id}:${stepId}`;
        record.steps.push(key);
        if (memo.has(key)) return memo.get(key) as never;
        const value = await body();
        memo.set(key, value);
        ranNewStep = true;
        return value;
      },
      async sendEvent(stepId, payload) {
        const key = `${id}:sendEvent:${stepId}`;
        if (memo.has(key)) return;
        for (const dispatched of asEvents(payload)) {
          record.events.push(dispatched);
          const listeners = registry.filter((candidate) =>
            triggersOf(candidate).some((t) => t.event === dispatched.name),
          );
          for (const listener of listeners) {
            await runScheduledFunction(listener, registry, {
              name: dispatched.name,
              data: dispatched.data,
            }).then((child) => {
              record.steps.push(...child.steps);
              record.events.push(...child.events);
              record.listenerErrors.push(...child.listenerErrors);
              Object.assign(record.returns, child.returns);
            });
          }
        }
        memo.set(key, true);
        ranNewStep = true;
      },
    };

    record.returns[id] = await handler({
      step,
      event: triggerEvent,
      events: [triggerEvent],
      runId: `replay-${id}`,
    });

    // Converged: an invocation that executed no new step is the final one.
    if (!ranNewStep) break;
  }

  return { ...record, invocations };
}
