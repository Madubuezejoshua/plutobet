import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { walletService, WalletService } from "../wallet/wallet.service";

/**
 * Records that a scheduled job ran, what it did, and HOW FAR IT GOT.
 *
 * WHY THE ORIGINAL VERSION WAS WORSE THAN NOTHING
 * -----------------------------------------------
 * The first version recorded `processed` and `settled` for one job, and the
 * caller passed `settled: 0` as a literal at the point the ingestion step
 * returned — before any settlement had been attempted. So a run reported
 * SUCCESS with "settled 0" while the dispatch that followed it never happened
 * at all.
 *
 * That is exactly what occurred. A real winning bet sat PENDING for hours in
 * front of a monitor that was structurally incapable of noticing, because the
 * monitor's success signal covered only the first link of the chain. The
 * operator reading it saw a healthy green job.
 *
 * **A result-ingestion success must never silence a settlement failure.** That
 * is the rule the shape below exists to enforce: a run reports each stage
 * separately, an `errorStage` names where it stopped, and settlement counts are
 * only ever incremented by code that actually verified a settlement.
 *
 * ASYNCHRONOUS WORK IS NOT "SETTLED"
 * ----------------------------------
 * `dispatchAccepted` means the scheduler took the work item. It does NOT mean
 * anybody was paid, and it is deliberately a different field from
 * `settlementCompleted` so the two can never be conflated again. Where
 * settlement happens in a child function, the child owns the completion count.
 */

/** Every stage a run can reach, in order. Named so an alert can say where. */
export type RunStage =
  | "claim"
  | "ingest"
  | "dispatch"
  | "settle"
  | "recover"
  | "close-markets"
  | "complete";

export interface HeartbeatCounts {
  /** Results fetched from the provider and stored this run. */
  ingestedResults?: number;
  /** Events now holding a final result. */
  finalEvents?: number;
  /** Work items the run tried to hand over. */
  dispatchAttempted?: number;
  /** Work items the scheduler accepted. NOT a settlement. */
  dispatchAccepted?: number;
  /** Bets actually settled, counted by the code that settled them. */
  settlementCompleted?: number;
  settlementFailed?: number;
  /** Inconsistent states the sweep found. */
  recoveryCandidates?: number;
  recovered?: number;
  /** Bets still PENDING on a final event AFTER this run. The alarm number. */
  pendingAfterRun?: number;
  marketClosures?: number;
}

export interface JobHeartbeat extends Required<HeartbeatCounts> {
  job: string;
  runId: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastError: string | null;
  errorStage: string | null;
  totalRuns: number;
  totalFailures: number;
}

/** Errors can carry a connection string; alerts must not. */
const MAX_ERROR_LENGTH = 300;

/** Thrown work carries the stage it failed at, so the alert can name it. */
export class StagedError extends Error {
  constructor(
    readonly stage: RunStage,
    readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "StagedError";
  }
}

/**
 * Turns any thrown value into something an operator can act on.
 *
 * `error.message` alone is not enough. Node's `AggregateError` for a failed
 * connection — several ETIMEDOUT attempts across a host's addresses — has an
 * EMPTY message, so the recovery job recorded seven failures with a blank
 * `last_error` and nothing to go on. An alert that says nothing is barely
 * better than no alert.
 *
 * The name and any `code` are included, and an AggregateError's first inner
 * error is unwrapped, because that is where the useful part lives.
 *
 * THE MESSAGE ITSELF IS THE LEAK. An earlier version of this comment claimed it
 * "never interpolates anything but a name, a code and a message" and treated
 * that as sufficient. It is not: postgres-js writes the host into the message,
 * so a stored heartbeat read
 *
 *   code CONNECT_TIMEOUT - write CONNECT_TIMEOUT ep-steep-mode-xxxx.c-5.us-east-2...
 *
 * publishing the database endpoint into a table an operator screenshots. So the
 * message is scrubbed of hostnames, IP addresses, ports and anything
 * credential-shaped before it is stored. The failure CLASS is what an operator
 * needs; the address of the thing that failed is never part of it.
 */
/**
 * Removes anything that identifies WHERE, keeping what says WHAT.
 *
 * Deliberately aggressive: a false positive costs a little detail in a log
 * line, and a false negative publishes infrastructure. Ordered longest-pattern
 * first so a URL is redacted whole rather than leaving its host behind.
 */
export function scrub(message: string): string {
  return (
    message
      // Whole connection URLs, credentials and all.
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
      // Hostnames with at least two dots: ep-xxx.c-5.us-east-2.aws.neon.tech
      .replace(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.){2,}[a-z]{2,}\b/gi, "<host>")
      // Bare IPv4, with or without a port.
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?/g, "<ip>")
      // IPv6 in brackets, and long bare IPv6 runs.
      .replace(/\[[0-9a-f:]+\](?::\d+)?/gi, "<ip>")
      .replace(/\b(?:[0-9a-f]{1,4}:){4,}[0-9a-f]{0,4}\b/gi, "<ip>")
      // A port left dangling once its host was replaced.
      .replace(/<host>:\d+/g, "<host>")
      .replace(/<ip>:\d+/g, "<ip>")
  );
}


export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return scrub(String(error));

  const parts: string[] = [];
  if (error.name && error.name !== "Error") parts.push(error.name);

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") parts.push(`code ${code}`);

  if (error.message) parts.push(scrub(error.message));

  /*
   * Unwrap when there is no MESSAGE, not when there is nothing at all.
   *
   * An AggregateError supplies a name, so keying off "parts is empty" left the
   * description as the bare word "AggregateError" — technically not blank, and
   * exactly as useless as the blank it replaced. The useful part is always in
   * the first inner error.
   */
  const inner = (error as { errors?: unknown }).errors;
  if (!error.message && Array.isArray(inner) && inner.length > 0) {
    parts.push(`${inner.length} attempt(s) failed: ${describeError(inner[0])}`);
  }

  return parts.length > 0 ? parts.join(" — ") : "unknown error with no message";
}

function zeroed(counts: HeartbeatCounts): Required<HeartbeatCounts> {
  return {
    ingestedResults: counts.ingestedResults ?? 0,
    finalEvents: counts.finalEvents ?? 0,
    dispatchAttempted: counts.dispatchAttempted ?? 0,
    dispatchAccepted: counts.dispatchAccepted ?? 0,
    settlementCompleted: counts.settlementCompleted ?? 0,
    settlementFailed: counts.settlementFailed ?? 0,
    recoveryCandidates: counts.recoveryCandidates ?? 0,
    recovered: counts.recovered ?? 0,
    pendingAfterRun: counts.pendingAfterRun ?? 0,
    marketClosures: counts.marketClosures ?? 0,
  };
}

export class HeartbeatService {
  constructor(private readonly wallet: WalletService = walletService) {}

  /** A correlation id, carried through every structured log line of a run. */
  newRunId(): string {
    return randomUUID();
  }

  async recordSuccess(
    job: string,
    counts: HeartbeatCounts,
    meta: { runId: string; startedAt: Date },
  ): Promise<void> {
    const c = zeroed(counts);
    // ISO string with an explicit cast, never a Date object: postgres-js
    // cannot bind a Date through `sql.execute`, and the failure surfaces as an
    // opaque ERR_INVALID_ARG_TYPE far from its cause. The same limitation is
    // noted in the odds sync for the same reason.
    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      await tx.execute(sql`
        INSERT INTO job_heartbeats (
          job, last_success_at, run_id, started_at, completed_at,
          processed_count, settled_count,
          ingested_result_count, final_event_count,
          dispatch_attempted_count, dispatch_accepted_count,
          settlement_completed_count, settlement_failed_count,
          recovery_candidate_count, recovered_count,
          pending_after_run_count, market_closure_count,
          error_stage, total_runs
        )
        VALUES (
          ${job}, now(), ${meta.runId}, ${meta.startedAt.toISOString()}::timestamptz, now(),
          ${c.ingestedResults}, ${c.settlementCompleted},
          ${c.ingestedResults}, ${c.finalEvents},
          ${c.dispatchAttempted}, ${c.dispatchAccepted},
          ${c.settlementCompleted}, ${c.settlementFailed},
          ${c.recoveryCandidates}, ${c.recovered},
          ${c.pendingAfterRun}, ${c.marketClosures},
          NULL, 1
        )
        ON CONFLICT (job) DO UPDATE SET
          last_success_at = now(),
          run_id = ${meta.runId},
          started_at = ${meta.startedAt.toISOString()}::timestamptz,
          completed_at = now(),
          processed_count = ${c.ingestedResults},
          settled_count = ${c.settlementCompleted},
          ingested_result_count = ${c.ingestedResults},
          final_event_count = ${c.finalEvents},
          dispatch_attempted_count = ${c.dispatchAttempted},
          dispatch_accepted_count = ${c.dispatchAccepted},
          settlement_completed_count = ${c.settlementCompleted},
          settlement_failed_count = ${c.settlementFailed},
          recovery_candidate_count = ${c.recoveryCandidates},
          recovered_count = ${c.recovered},
          pending_after_run_count = ${c.pendingAfterRun},
          market_closure_count = ${c.marketClosures},
          error_stage = NULL,
          total_runs = job_heartbeats.total_runs + 1,
          updated_at = now()
      `);
    });
  }

  async recordFailure(
    job: string,
    error: unknown,
    meta: { runId: string; startedAt: Date; stage: RunStage },
  ): Promise<void> {
    const message = describeError(error).slice(0, MAX_ERROR_LENGTH);
    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      await tx.execute(sql`
        INSERT INTO job_heartbeats (
          job, last_failure_at, last_error, error_stage,
          run_id, started_at, total_runs, total_failures
        )
        VALUES (${job}, now(), ${message}, ${meta.stage}, ${meta.runId}, ${meta.startedAt.toISOString()}::timestamptz, 1, 1)
        ON CONFLICT (job) DO UPDATE SET
          last_failure_at = now(),
          last_error = ${message},
          error_stage = ${meta.stage},
          run_id = ${meta.runId},
          started_at = ${meta.startedAt.toISOString()}::timestamptz,
          total_runs = job_heartbeats.total_runs + 1,
          total_failures = job_heartbeats.total_failures + 1,
          updated_at = now()
      `);
    });
  }

  async read(job: string): Promise<JobHeartbeat | null> {
    const rows = (await this.wallet.withMoneyTransaction(async ({ tx }) =>
      tx.execute(sql`
        SELECT job, run_id, started_at, completed_at,
               last_success_at, last_failure_at, last_error, error_stage,
               ingested_result_count, final_event_count,
               dispatch_attempted_count, dispatch_accepted_count,
               settlement_completed_count, settlement_failed_count,
               recovery_candidate_count, recovered_count,
               pending_after_run_count, market_closure_count,
               total_runs, total_failures
        FROM job_heartbeats WHERE job = ${job}
      `),
    )) as Record<string, unknown>[];

    const row = rows[0];
    if (!row) return null;
    const date = (value: unknown) => (value ? new Date(value as string) : null);
    return {
      job: String(row.job),
      runId: row.run_id === null ? null : String(row.run_id),
      startedAt: date(row.started_at),
      completedAt: date(row.completed_at),
      lastSuccessAt: date(row.last_success_at),
      lastFailureAt: date(row.last_failure_at),
      lastError: row.last_error === null ? null : String(row.last_error),
      errorStage: row.error_stage === null ? null : String(row.error_stage),
      ingestedResults: Number(row.ingested_result_count),
      finalEvents: Number(row.final_event_count),
      dispatchAttempted: Number(row.dispatch_attempted_count),
      dispatchAccepted: Number(row.dispatch_accepted_count),
      settlementCompleted: Number(row.settlement_completed_count),
      settlementFailed: Number(row.settlement_failed_count),
      recoveryCandidates: Number(row.recovery_candidate_count),
      recovered: Number(row.recovered_count),
      pendingAfterRun: Number(row.pending_after_run_count),
      marketClosures: Number(row.market_closure_count),
      totalRuns: Number(row.total_runs),
      totalFailures: Number(row.total_failures),
    };
  }

  /**
   * Wraps a job so a heartbeat is written whichever way it ends.
   *
   * The work reports its OWN counts, per stage. Nothing here invents a number,
   * and in particular nothing here can report a settlement — that count comes
   * from the code that performed one.
   *
   * The failure path re-throws: the scheduler must still see the error and
   * retry. Recording it is for the operator, not a substitute for the
   * platform's own handling.
   */
  async track<T extends HeartbeatCounts>(
    job: string,
    run: (runId: string) => Promise<T>,
  ): Promise<T> {
    const runId = this.newRunId();
    const startedAt = new Date();
    try {
      const result = await run(runId);
      await this.recordSuccess(job, result, { runId, startedAt });
      return result;
    } catch (error) {
      const stage = error instanceof StagedError ? error.stage : "complete";
      const cause = error instanceof StagedError ? error.cause : error;
      await this.recordFailure(job, cause, { runId, startedAt, stage });
      throw cause;
    }
  }
}

export const heartbeatService = new HeartbeatService();
