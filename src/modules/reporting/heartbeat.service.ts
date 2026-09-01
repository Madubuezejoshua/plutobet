import { sql } from "drizzle-orm";
import { walletService, WalletService } from "../wallet/wallet.service";

/**
 * Records that a scheduled job ran, and what it did.
 *
 * The settlement poller had never executed once, and nothing anywhere could
 * say so. A bet on a finished match would sit PENDING indefinitely and the
 * first signal would be a customer asking where their winnings were. A job
 * that silently stops is worse than one that fails loudly.
 *
 * Zero counts are recorded deliberately: "ran and found nothing" and "did not
 * run" look identical from the outside otherwise, and only one of them is a
 * problem.
 */

export interface HeartbeatCounts {
  processed: number;
  settled: number;
}

export interface JobHeartbeat {
  job: string;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastError: string | null;
  processedCount: number;
  settledCount: number;
  totalRuns: number;
  totalFailures: number;
}

/** Errors can carry a connection string; alerts must not. */
const MAX_ERROR_LENGTH = 300;

export class HeartbeatService {
  constructor(private readonly wallet: WalletService = walletService) {}

  async recordSuccess(job: string, counts: HeartbeatCounts): Promise<void> {
    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      await tx.execute(sql`
        INSERT INTO job_heartbeats (job, last_success_at, processed_count, settled_count, total_runs)
        VALUES (${job}, now(), ${counts.processed}, ${counts.settled}, 1)
        ON CONFLICT (job) DO UPDATE SET
          last_success_at = now(),
          processed_count = ${counts.processed},
          settled_count = ${counts.settled},
          total_runs = job_heartbeats.total_runs + 1,
          updated_at = now()
      `);
    });
  }

  async recordFailure(job: string, error: unknown): Promise<void> {
    const message = (error instanceof Error ? error.message : String(error)).slice(
      0,
      MAX_ERROR_LENGTH,
    );
    await this.wallet.withMoneyTransaction(async ({ tx }) => {
      await tx.execute(sql`
        INSERT INTO job_heartbeats (job, last_failure_at, last_error, total_runs, total_failures)
        VALUES (${job}, now(), ${message}, 1, 1)
        ON CONFLICT (job) DO UPDATE SET
          last_failure_at = now(),
          last_error = ${message},
          total_runs = job_heartbeats.total_runs + 1,
          total_failures = job_heartbeats.total_failures + 1,
          updated_at = now()
      `);
    });
  }

  async read(job: string): Promise<JobHeartbeat | null> {
    const rows = (await this.wallet.withMoneyTransaction(async ({ tx }) =>
      tx.execute(sql`
        SELECT job, last_success_at, last_failure_at, last_error,
               processed_count, settled_count, total_runs, total_failures
        FROM job_heartbeats WHERE job = ${job}
      `),
    )) as Record<string, unknown>[];

    const row = rows[0];
    if (!row) return null;
    return {
      job: String(row.job),
      lastSuccessAt: row.last_success_at ? new Date(row.last_success_at as string) : null,
      lastFailureAt: row.last_failure_at ? new Date(row.last_failure_at as string) : null,
      lastError: row.last_error === null ? null : String(row.last_error),
      processedCount: Number(row.processed_count),
      settledCount: Number(row.settled_count),
      totalRuns: Number(row.total_runs),
      totalFailures: Number(row.total_failures),
    };
  }

  /**
   * Wraps a job so a heartbeat is written whichever way it ends.
   *
   * The failure path re-throws: Inngest must still see the error and retry.
   * Recording it here is for the operator, not a substitute for the platform's
   * own handling.
   */
  async track<T extends HeartbeatCounts>(job: string, run: () => Promise<T>): Promise<T> {
    try {
      const result = await run();
      await this.recordSuccess(job, result);
      return result;
    } catch (error) {
      await this.recordFailure(job, error);
      throw error;
    }
  }
}

export const heartbeatService = new HeartbeatService();
