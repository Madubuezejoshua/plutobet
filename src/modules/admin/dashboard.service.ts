import { sql } from "drizzle-orm";
import { redis } from "@/db/redis";
import { walletService, WalletService } from "../wallet/wallet.service";

/**
 * The admin dashboard's figures.
 *
 * Everything here is read from the ledger and the operational tables — there
 * is no metrics table and no cached aggregate, so a number shown to an
 * operator reconciles with the transaction record a regulator would be given.
 *
 * That costs a handful of aggregate queries per page load. At the volume an
 * admin dashboard is viewed, correctness is worth more than the milliseconds,
 * and a stale metrics table is how an operator ends up making a decision from
 * yesterday's exposure.
 */

export interface DashboardMetrics {
  users: { total: number; newToday: number; suspended: number };
  money: {
    depositsTodayMinor: bigint;
    withdrawalsTodayMinor: bigint;
    stakesTodayMinor: bigint;
    payoutsTodayMinor: bigint;
  };
  queues: { pendingWithdrawals: number; pendingKyc: number; flaggedWallets: number };
}

export type HealthState = "OK" | "DEGRADED" | "DOWN" | "UNKNOWN";

export interface HealthCheck {
  component: string;
  state: HealthState;
  detail: string;
  latencyMs: number | null;
}

export class DashboardService {
  constructor(private readonly wallet: WalletService = walletService) {}

  async metrics(): Promise<DashboardMetrics> {
    return this.wallet.withMoneyTransaction(async ({ tx }) => {
      const [users] = await tx.execute<{
        total: number;
        new_today: number;
        suspended: number;
      }>(sql`
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS new_today,
          count(*) FILTER (WHERE status <> 'ACTIVE')::int AS suspended
        FROM users
      `);

      /*
       * Money moved today, straight from the ledger.
       *
       * Summed over CREDIT legs to user wallets for money in, and DEBIT legs
       * for money out, because that is what the double-entry record actually
       * says. Reading a `deposits` table instead would show what we *intended*
       * to happen; this shows what did.
       */
      const [money] = await tx.execute<{
        deposits: string;
        withdrawals: string;
        stakes: string;
        payouts: string;
      }>(sql`
        SELECT
          COALESCE(SUM(e.amount_minor) FILTER (
            WHERE t.type = 'DEPOSIT' AND e.direction = 'CREDIT'), 0)::text AS deposits,
          COALESCE(SUM(e.amount_minor) FILTER (
            WHERE t.type = 'WITHDRAWAL' AND e.direction = 'DEBIT'), 0)::text AS withdrawals,
          COALESCE(SUM(e.amount_minor) FILTER (
            WHERE t.type = 'STAKE' AND e.direction = 'DEBIT'), 0)::text AS stakes,
          COALESCE(SUM(e.amount_minor) FILTER (
            WHERE t.type = 'PAYOUT' AND e.direction = 'CREDIT'), 0)::text AS payouts
        FROM ledger_entries e
        JOIN ledger_transactions t ON t.id = e.txn_id
        JOIN wallets w ON w.id = e.wallet_id
        WHERE w.kind = 'USER'
          AND t.created_at >= date_trunc('day', now())
      `);

      const [queues] = await tx.execute<{
        pending_withdrawals: number;
        pending_kyc: number;
        flagged_wallets: number;
      }>(sql`
        SELECT
          (SELECT count(*) FROM withdrawals WHERE status IN ('REQUESTED', 'APPROVED'))::int
            AS pending_withdrawals,
          (SELECT count(*) FROM kyc_records
             WHERE status = 'PENDING' AND document_key IS NOT NULL)::int AS pending_kyc,
          (SELECT count(*) FROM wallets WHERE reconciliation_status = 'FLAGGED')::int
            AS flagged_wallets
      `);

      return {
        users: {
          total: Number(users?.total ?? 0),
          newToday: Number(users?.new_today ?? 0),
          suspended: Number(users?.suspended ?? 0),
        },
        money: {
          depositsTodayMinor: BigInt(money?.deposits ?? "0"),
          withdrawalsTodayMinor: BigInt(money?.withdrawals ?? "0"),
          stakesTodayMinor: BigInt(money?.stakes ?? "0"),
          payoutsTodayMinor: BigInt(money?.payouts ?? "0"),
        },
        queues: {
          pendingWithdrawals: Number(queues?.pending_withdrawals ?? 0),
          pendingKyc: Number(queues?.pending_kyc ?? 0),
          flaggedWallets: Number(queues?.flagged_wallets ?? 0),
        },
      };
    });
  }

  /**
   * System health.
   *
   * Only two components are genuinely probed, because only two can be probed
   * honestly from here: the database and Redis both answer a round-trip. The
   * rest report UNKNOWN rather than green.
   *
   * A dashboard that shows a reassuring tick for something it never checked is
   * worse than one that admits it does not know — the first actively misleads
   * an operator during an incident.
   */
  async health(): Promise<HealthCheck[]> {
    const [database, cache] = await Promise.all([this.checkDatabase(), this.checkRedis()]);

    return [
      database,
      cache,
      {
        component: "Odds provider",
        state: "UNKNOWN",
        detail: "No liveness probe yet. Sync failures surface in Inngest and Sentry.",
        latencyMs: null,
      },
      {
        component: "Background jobs",
        state: "UNKNOWN",
        detail: "Inngest reports its own run history; not queried from here yet.",
        latencyMs: null,
      },
      {
        component: "Payments",
        state: process.env.PAYSTACK_SECRET_KEY ? "UNKNOWN" : "DOWN",
        detail: process.env.PAYSTACK_SECRET_KEY
          ? "Credentials present. No liveness probe yet."
          : "PAYSTACK_SECRET_KEY is not configured — deposits and withdrawals cannot run.",
        latencyMs: null,
      },
      {
        component: "Notifications",
        state: process.env.TERMII_API_KEY || process.env.RESEND_API_KEY ? "UNKNOWN" : "DEGRADED",
        detail:
          process.env.TERMII_API_KEY || process.env.RESEND_API_KEY
            ? "At least one provider is configured."
            : "No SMS or email provider configured — codes are only written to the server log.",
        latencyMs: null,
      },
    ];
  }

  private async checkDatabase(): Promise<HealthCheck> {
    const started = Date.now();
    try {
      await this.wallet.withMoneyTransaction(async ({ tx }) => {
        await tx.execute(sql`SELECT 1`);
      });
      const latencyMs = Date.now() - started;
      return {
        component: "Database",
        // Not a hard failure, but a money path that takes this long under a
        // row lock is worth an operator's attention before it becomes one.
        state: latencyMs > 1000 ? "DEGRADED" : "OK",
        detail: latencyMs > 1000 ? "Responding slowly" : "Responding normally",
        latencyMs,
      };
    } catch (error) {
      return {
        component: "Database",
        state: "DOWN",
        detail: error instanceof Error ? error.message.slice(0, 120) : "Unreachable",
        latencyMs: Date.now() - started,
      };
    }
  }

  private async checkRedis(): Promise<HealthCheck> {
    const started = Date.now();
    try {
      await redis.ping();
      const latencyMs = Date.now() - started;
      return {
        component: "Cache / rate limits",
        state: latencyMs > 500 ? "DEGRADED" : "OK",
        detail: latencyMs > 500 ? "Responding slowly" : "Responding normally",
        latencyMs,
      };
    } catch (error) {
      return {
        component: "Cache / rate limits",
        state: "DOWN",
        // Worth spelling out: this is not a cache miss, it is an open door.
        detail: `Rate limiting and the odds budget are unenforced while this is down. ${
          error instanceof Error ? error.message.slice(0, 80) : ""
        }`.trim(),
        latencyMs: Date.now() - started,
      };
    }
  }
}

export const dashboardService = new DashboardService();
