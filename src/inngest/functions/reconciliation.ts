import * as Sentry from "@sentry/nextjs";
import { reconciliationService } from "@/modules/reconciliation/reconciliation.service";
import { inngest } from "../client";

/**
 * Daily financial reconciliation.
 *
 * Runs in the small hours, after the day's settlement has drained. A finding
 * here is never routine: the live constraints already prevent both failures
 * it looks for, so anything it reports means a guard is missing rather than
 * merely that a number is off.
 */
export const dailyReconciliation = inngest.createFunction(
  {
    id: "daily-financial-reconciliation",
    name: "Daily financial reconciliation",
    triggers: { cron: "23 3 * * *" },
    concurrency: { limit: 1 },
  },
  async ({ step }) => {
    const report = await step.run("reconcile", () => reconciliationService.runDaily());

    if (!report.clean) {
      await step.run("alert", async () => {
        // Fatal, not error: money the books cannot explain is the single
        // finding that should wake someone up.
        Sentry.captureException(new Error("daily reconciliation found discrepancies"), {
          level: "fatal",
          tags: { subsystem: "reconciliation" },
          extra: {
            unbalanced: report.unbalancedTransactions.length,
            driftedWallets: report.walletDrift.length,
            // Bounded: a systemic fault could produce hundreds, and the
            // alert must stay readable enough to act on.
            sampleUnbalanced: report.unbalancedTransactions.slice(0, 10),
            sampleDrift: report.walletDrift.slice(0, 10),
          },
          fingerprint: ["reconciliation-discrepancy"],
        });
        await Sentry.flush(2_000);
      });
    }

    return {
      clean: report.clean,
      unbalanced: report.unbalancedTransactions.length,
      drifted: report.walletDrift.length,
    };
  },
);
