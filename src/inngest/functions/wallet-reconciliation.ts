import * as Sentry from "@sentry/nextjs";
import { NonRetriableError } from "inngest";
import { z } from "zod";
import { walletReconciliationService } from "@/modules/wallet/reconciliation.service";
import { inngest } from "../client";

const DISPATCH_PAGE_SIZE = 500;
const EVENT_BATCH_SIZE = 100;
const reconciliationRequestSchema = z.object({ walletId: z.string().uuid() });

export const scheduleWalletReconciliation = inngest.createFunction(
  {
    id: "schedule-wallet-reconciliation",
    name: "Schedule wallet reconciliation",
    triggers: { cron: "17 2 * * *" },
    concurrency: { limit: 1 },
  },
  async ({ step, runId }) => {
    let afterId: string | undefined;
    let page = 0;
    let dispatched = 0;

    do {
      const walletIds = await step.run(`list-wallets-${page}`, () =>
        walletReconciliationService.listWalletIds(afterId, DISPATCH_PAGE_SIZE),
      );
      if (walletIds.length === 0) break;

      for (let offset = 0; offset < walletIds.length; offset += EVENT_BATCH_SIZE) {
        const batch = walletIds.slice(offset, offset + EVENT_BATCH_SIZE);
        await step.sendEvent(
          `dispatch-wallets-${page}-${offset / EVENT_BATCH_SIZE}`,
          batch.map((walletId) => ({
            id: `wallet-reconciliation:${runId}:${walletId}`,
            name: "wallet/reconciliation.requested",
            data: { walletId },
          })),
        );
        dispatched += batch.length;
      }

      afterId = walletIds.at(-1);
      page += 1;
      if (walletIds.length < DISPATCH_PAGE_SIZE) break;
    } while (afterId);

    return { dispatched };
  },
);

export const reconcileWallet = inngest.createFunction(
  {
    id: "reconcile-wallet",
    name: "Reconcile one wallet",
    triggers: { event: "wallet/reconciliation.requested" },
    concurrency: { limit: 10 },
  },
  async ({ event, step }) => {
    const payload = reconciliationRequestSchema.safeParse(event.data);
    if (!payload.success) {
      // Retrying a malformed external event can never make it valid and only
      // burns execution history/quota. Do not include the raw payload in the
      // error because future event shapes may contain sensitive data.
      throw new NonRetriableError("invalid wallet reconciliation event payload");
    }
    const { walletId } = payload.data;
    const result = await step.run("replay-ledger", async () => {
      const drift = await walletReconciliationService.reconcileWallet(walletId);
      return {
        ...drift,
        cachedMinor: drift.cachedMinor.toString(),
        computedMinor: drift.computedMinor.toString(),
        driftMinor: drift.driftMinor.toString(),
      };
    });

    if (result.status === "FLAGGED") {
      await step.run("alert-critical-drift", async () => {
        Sentry.captureException(new Error(`wallet ledger mismatch: ${result.walletId}`), {
          level: "fatal",
          tags: { subsystem: "wallet-reconciliation", walletId: result.walletId },
          extra: result,
          fingerprint: ["wallet-ledger-mismatch", result.walletId],
        });
        await Sentry.flush(2_000);
      });
    }

    return result;
  },
);
