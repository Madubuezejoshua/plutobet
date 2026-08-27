import * as Sentry from "@sentry/nextjs";
import { sql } from "drizzle-orm";
import { NonRetriableError } from "inngest";
import { z } from "zod";
import { PaystackError } from "@/modules/payments/paystack";
import { paymentProvider } from "@/modules/payments/factory";
import { withdrawalService } from "@/modules/payments/withdrawal.service";
import { walletService } from "@/modules/wallet/wallet.service";
import { inngest } from "../client";

/**
 * Payout execution — the engine behind the withdrawal state machine.
 *
 * Before this existed, `submitToProvider` was written, tested and never
 * called. A withdrawal could be approved and would then sit at APPROVED
 * forever: the customer's money had left their balance and was going nowhere.
 * That is the single worst failure mode a betting platform has, because it is
 * indistinguishable from theft from the customer's side.
 *
 * WHY A QUEUE RATHER THAN DOING IT IN THE APPROVAL REQUEST
 * A bank transfer is a slow third-party HTTP call. Doing it inside the admin's
 * approve request would hold a row lock across it, stall every other
 * withdrawal behind one slow bank, and — worst — leave the outcome ambiguous
 * if the request timed out. Here, a crash mid-flight leaves the row at
 * PROCESSING, which the reconciler can resolve.
 *
 * WHY CONCURRENCY IS 1
 * Payouts are not throughput-sensitive and the failure modes of parallel ones
 * are severe. One at a time is fast enough for any volume this platform will
 * see for a long while, and makes the ordering trivially auditable.
 */

const BATCH_SIZE = 25;

const submitPayoutSchema = z.object({ withdrawalId: z.string().uuid() });

export const scheduleApprovedPayouts = inngest.createFunction(
  {
    id: "schedule-approved-payouts",
    name: "Submit approved withdrawals to the payment provider",
    triggers: { cron: "*/5 * * * *" },
    concurrency: { limit: 1 },
  },
  async ({ step }) => {
    const approved = await step.run("find-approved", async () =>
      walletService.withMoneyTransaction(async ({ tx }) => {
        const rows = await tx.execute<{ id: string }>(sql`
          SELECT id FROM withdrawals
          WHERE status = 'APPROVED'
          ORDER BY created_at ASC
          LIMIT ${BATCH_SIZE}
        `);
        return rows.map((row) => row.id);
      }),
    );

    if (approved.length === 0) return { submitted: 0 };

    await Promise.all(
      approved.map((withdrawalId) =>
        step.sendEvent(`submit:${withdrawalId}`, {
          name: "payouts/submit",
          data: { withdrawalId },
        }),
      ),
    );

    return { submitted: approved.length };
  },
);

export const submitPayout = inngest.createFunction(
  {
    id: "submit-payout",
    name: "Submit one withdrawal to the payment provider",
    triggers: { event: "payouts/submit" },
    // Never two transfers in flight for the same withdrawal.
    concurrency: { limit: 1, key: "event.data.withdrawalId" },
    retries: 3,
  },
  async ({ event, step }) => {
    const parsed = submitPayoutSchema.safeParse(event.data);
    if (!parsed.success) {
      // Retrying a malformed event can never make it valid.
      throw new NonRetriableError("invalid payout event payload");
    }
    const { withdrawalId } = parsed.data;

    try {
      await step.run("submit", () =>
        withdrawalService.submitToProvider(withdrawalId, paymentProvider()),
      );
    } catch (error) {
      /*
       * A retryable provider error is re-thrown so Inngest backs off and tries
       * again — the withdrawal stays PROCESSING in the meantime, which is
       * accurate: we genuinely do not know whether the transfer landed.
       *
       * A NON-retryable error is different. The provider actively refused
       * (bad account number, insufficient float), so retrying just collects
       * the same refusal. Those are settled as FAILED, which returns the held
       * funds to the customer.
       *
       * The distinction matters enormously. Treating a timeout as a failure
       * would refund a customer whose money is already in flight — paying
       * them twice.
       */
      if (error instanceof PaystackError && !error.retryable) {
        await step.run("settle-as-failed", () =>
          withdrawalService.reconcile(withdrawalId, {
            status: "FAILED",
            failureReason: error.providerMessage.slice(0, 300),
          }),
        );

        Sentry.captureException(error, {
          level: "error",
          tags: { subsystem: "payouts" },
          extra: { withdrawalId, outcome: "refunded" },
        });
        return { withdrawalId, outcome: "FAILED" };
      }

      Sentry.captureException(error, {
        level: "warning",
        tags: { subsystem: "payouts" },
        extra: { withdrawalId, outcome: "will-retry" },
      });
      throw error;
    }

    return { withdrawalId, outcome: "SUBMITTED" };
  },
);

/**
 * Catches withdrawals stuck in PROCESSING.
 *
 * A transfer whose webhook never arrived — provider outage, a dropped
 * delivery, a crash between submitting and recording — would otherwise sit
 * forever with the customer's money neither paid nor returned.
 *
 * This deliberately does NOT resolve them automatically. Deciding that a
 * transfer failed, when it might have succeeded and simply not been reported,
 * risks paying twice; deciding it succeeded risks never paying at all.
 * Neither is safe to guess, so a human is told instead.
 */
export const alertStalePayouts = inngest.createFunction(
  {
    id: "alert-stale-payouts",
    name: "Alert on withdrawals stuck in processing",
    triggers: { cron: "17 * * * *" },
    concurrency: { limit: 1 },
  },
  async ({ step }) => {
    const stale = await step.run("find-stale", async () =>
      walletService.withMoneyTransaction(async ({ tx }) => {
        const rows = await tx.execute<{ id: string; amount_minor: string; updated_at: Date }>(sql`
          SELECT id, amount_minor::text AS amount_minor, updated_at
          FROM withdrawals
          WHERE status = 'PROCESSING'
            AND updated_at < now() - INTERVAL '2 hours'
          ORDER BY updated_at ASC
          LIMIT 50
        `);
        return rows.map((row) => ({
          id: row.id,
          amountMinor: row.amount_minor,
          stuckSince: new Date(row.updated_at).toISOString(),
        }));
      }),
    );

    if (stale.length === 0) return { stale: 0 };

    await step.run("alert", async () => {
      Sentry.captureException(new Error(`${stale.length} withdrawals stuck in PROCESSING`), {
        level: "error",
        tags: { subsystem: "payouts" },
        extra: { withdrawals: stale.slice(0, 20) },
        fingerprint: ["stale-payouts"],
      });
      await Sentry.flush(2_000);
    });

    return { stale: stale.length };
  },
);
