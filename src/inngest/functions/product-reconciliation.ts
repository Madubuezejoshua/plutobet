import * as Sentry from "@sentry/nextjs";
import { productReconciliationService } from "@/modules/reconciliation/product-reconciliation.service";
import { inngest } from "../client";

/**
 * Nightly cross-product reconciliation.
 *
 * Runs after the wallet reconciliation, which checks balances against their own
 * ledger entries. This checks the other direction: whether every domain record
 * agrees with the money that moved for it.
 *
 * A finding here is never routine. The live constraints already prevent all of
 * these, so anything returned means a guard is missing or was bypassed — which
 * is a code investigation, not a number to adjust.
 */
export const nightlyProductReconciliation = inngest.createFunction(
  {
    id: "nightly-product-reconciliation",
    name: "Reconcile products against the ledger",
    triggers: { cron: "41 4 * * *" },
    concurrency: { limit: 1 },
  },
  async ({ step }) => {
    const report = await step.run("reconcile", () => productReconciliationService.run());

    if (!report.clean) {
      await step.run("alert", async () => {
        const critical = report.findings.filter((f) => f.severity === "CRITICAL");
        Sentry.captureException(
          new Error(`product reconciliation found ${report.findings.length} issues`),
          {
            // Fatal when money is involved: a bet with no stake or a deposit
            // that never landed should wake somebody, not wait for a morning
            // dashboard.
            level: critical.length > 0 ? "fatal" : "error",
            tags: { subsystem: "reconciliation" },
            extra: { findings: report.findings },
            fingerprint: ["product-reconciliation"],
          },
        );
        await Sentry.flush(2_000);
      });
    }

    return { clean: report.clean, findings: report.findings.length };
  },
);
