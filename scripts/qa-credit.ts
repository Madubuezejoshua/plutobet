/**
 * Phase 6: fund a QA account through the REAL ledger service.
 *
 *   ALLOW_QA_CREDIT=true npx tsx scripts/qa-credit.ts <userId> <kobo>
 *
 * THIS IS NOT A DEPOSIT. Paystack is not involved and nothing here proves the
 * payment gateway works. It posts an ADJUSTMENT against ADJUSTMENTS_EQUITY so
 * the betting engine can be exercised without a live payment rail, which is a
 * different claim entirely.
 *
 * Three guards, because a script that can mint money must be hard to run by
 * accident and impossible to run in production:
 *
 *   1. refuses when NODE_ENV=production
 *   2. requires ALLOW_QA_CREDIT=true
 *   3. requires an explicit user id and amount — no defaults, no "all users"
 *
 * It calls walletService.credit, so every ledger invariant, trigger and
 * idempotency guarantee applies exactly as it does to a real payout. There is
 * deliberately no SQL UPDATE of a balance anywhere in this file.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { walletService } from "@/modules/wallet/wallet.service";

function refuse(reason: string): never {
  console.error(`REFUSED: ${reason}`);
  process.exit(1);
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    refuse("NODE_ENV=production — this script must never run against production");
  }
  if (process.env.ALLOW_QA_CREDIT !== "true") {
    refuse("ALLOW_QA_CREDIT is not 'true' — refusing to create money by accident");
  }

  const userId = process.argv[2]?.trim();
  const amountRaw = process.argv[3]?.trim();
  const idempotencyKey = process.argv[4]?.trim() ?? `qa-credit:${userId}:${amountRaw}`;

  if (!userId || !amountRaw) {
    refuse("usage: qa-credit.ts <userId> <amountKobo> [idempotencyKey]");
  }
  if (!/^\d+$/.test(amountRaw)) {
    // Money is integer kobo everywhere. Accepting "200.00" here would be the
    // one place a float could enter the system.
    refuse(`amount must be whole kobo, got "${amountRaw}"`);
  }

  const amountMinor = BigInt(amountRaw);
  if (amountMinor <= 0n) refuse("amount must be positive");

  const result = await walletService.withMoneyTransaction(async ({ tx, credit }) => {
    // Resolve the CASH bucket explicitly. A lookup by (user_id, kind,
    // currency) matches all three bucket rows and returns whichever the
    // planner picks first — the bug that once put six credits in the wrong
    // bucket while the ledger stayed perfectly balanced.
    const [wallet] = await tx.execute<{ id: string; cached_balance_minor: string }>(sql`
      SELECT id::text, cached_balance_minor::text
      FROM wallets
      WHERE user_id = ${userId}::uuid
        AND kind = 'USER'
        AND currency = 'NGN'
        AND bucket = 'CASH'
    `);
    if (!wallet) throw new Error(`no CASH wallet for user ${userId}`);

    const before = BigInt(wallet.cached_balance_minor);
    const operation = await credit({
      walletId: wallet.id,
      amountMinor,
      type: "ADJUSTMENT",
      idempotencyKey,
      actor: { type: "SYSTEM" },
      metadata: { reason: "QA_VALIDATION_CREDIT", issuedBy: "scripts/qa-credit.ts" },
    });

    return { walletId: wallet.id, before, operation };
  });

  console.log(`wallet   : ${result.walletId} (CASH)`);
  console.log(`before   : ${result.before} kobo`);
  console.log(`after    : ${result.operation.balanceAfterMinor} kobo`);
  console.log(`txn      : ${result.operation.transactionId}`);
  console.log(`idempotent replay: ${result.operation.idempotent}`);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error("qa-credit failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
