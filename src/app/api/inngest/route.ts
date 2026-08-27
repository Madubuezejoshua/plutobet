import { serve } from "inngest/next";
import { inngest } from "@/inngest/client";
import { syncFixtures, syncLiveOdds, syncOddsDelta } from "@/inngest/functions/odds-sync";
import { dailyReconciliation } from "@/inngest/functions/reconciliation";
import {
  alertStalePayouts,
  scheduleApprovedPayouts,
  submitPayout,
} from "@/inngest/functions/payouts";
import { pollMatchResults, settleBet, settleEvent } from "@/inngest/functions/settlement";
import { reconcileWallet, scheduleWalletReconciliation } from "@/inngest/functions/wallet-reconciliation";

export const runtime = "nodejs";
export const maxDuration = 60;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    scheduleWalletReconciliation,
    reconcileWallet,
    syncFixtures,
    syncOddsDelta,
    syncLiveOdds,
    pollMatchResults,
    settleEvent,
    settleBet,
    dailyReconciliation,
    scheduleApprovedPayouts,
    submitPayout,
    alertStalePayouts,
  ],
});
