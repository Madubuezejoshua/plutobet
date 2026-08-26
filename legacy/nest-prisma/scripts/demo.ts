/**
 * Live walkthrough of WalletService against the real dev database — deposit,
 * stake, payout, a rejected withdrawal, and an idempotent replay. Prints the
 * resulting ledger. Not a test; a narrated demonstration.
 *
 *   npm run db:dev            (separate terminal, leave running)
 *   npx tsx scripts/demo.ts
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { WalletService } from "../src/wallet/wallet.service";
import { WalletReconciliationService } from "../src/wallet/wallet-reconciliation.service";
import { InsufficientFundsError } from "../src/wallet/wallet.types";

function naira(minor: bigint): string {
  const sign = minor < 0n ? "-" : "";
  const abs = minor < 0n ? -minor : minor;
  return `${sign}₦${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, "0")}`;
}

async function main() {
  const prisma = new PrismaService();
  await prisma.$connect();
  const wallets = new WalletService(prisma);
  const reconciliation = new WalletReconciliationService(prisma);

  const email = `demo-${randomUUID().slice(0, 8)}@bet.local`;
  const user = await prisma.user.create({ data: { email } });
  const wallet = await prisma.wallet.create({
    data: { kind: "user", userId: user.id, currency: "NGN", cachedBalanceMinor: 0n },
  });
  console.log(`\nCreated user ${email}, wallet ${wallet.id}, starting balance ${naira(0n)}`);

  // 1. Deposit ₦50,000 via Paystack (simulated webhook reference)
  const depositRef = `paystack:${randomUUID()}`;
  const deposit = await wallets.credit({
    walletId: wallet.id,
    amountMinor: 5_000_000n, // ₦50,000.00
    counterparty: "cash_in",
    type: "deposit",
    idempotencyKey: `deposit:${depositRef}`,
    reference: depositRef,
    actor: { type: "user", id: user.id },
  });
  console.log(`Deposit ₦50,000.00 -> balance ${naira(deposit.balanceAfterMinor)}`);

  // 2. Same webhook fires again (Paystack retries). Must not double-credit.
  const replay = await wallets.credit({
    walletId: wallet.id,
    amountMinor: 5_000_000n,
    counterparty: "cash_in",
    type: "deposit",
    idempotencyKey: `deposit:${depositRef}`,
    reference: depositRef,
    actor: { type: "user", id: user.id },
  });
  console.log(
    `Paystack retries the same webhook -> idempotent=${replay.idempotent}, balance still ${naira(replay.balanceAfterMinor)}`,
  );

  // 3. Place a ₦2,000 stake on a 1X2 market
  const betId = randomUUID();
  const stake = await wallets.debit({
    walletId: wallet.id,
    amountMinor: 200_000n, // ₦2,000.00
    counterparty: "stakes_liability",
    type: "stake",
    idempotencyKey: `stake:${betId}`,
    actor: { type: "user", id: user.id },
    metadata: { betId },
  });
  console.log(`Stake ₦2,000.00 on bet ${betId.slice(0, 8)} -> balance ${naira(stake.balanceAfterMinor)}`);

  // 4. That bet wins at odds 2.50 -> payout ₦5,000
  const payout = await wallets.credit({
    walletId: wallet.id,
    amountMinor: 500_000n, // ₦5,000.00
    counterparty: "payouts_payable",
    type: "payout",
    idempotencyKey: `payout:${betId}`,
    actor: { type: "system" },
    metadata: { betId },
  });
  console.log(`Bet ${betId.slice(0, 8)} wins, payout ₦5,000.00 -> balance ${naira(payout.balanceAfterMinor)}`);

  // 5. Try to withdraw more than the balance
  try {
    await wallets.debit({
      walletId: wallet.id,
      amountMinor: 999_999_999n,
      counterparty: "cash_out",
      type: "withdrawal",
      idempotencyKey: `withdrawal:${randomUUID()}`,
      actor: { type: "user", id: user.id },
    });
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      console.log(`Withdraw ₦9,999,999.99 -> rejected cleanly: ${err.message}`);
    } else {
      throw err;
    }
  }

  const finalBalance = await wallets.getBalance(wallet.id);
  console.log(`\nFinal balance: ${naira(finalBalance)}`);

  const drift = await reconciliation.reconcileWallet(wallet.id);
  console.log(
    `Reconciliation: cached=${naira(drift!.cachedMinor)} computed-from-ledger=${naira(drift!.computedMinor)} drift=${drift!.driftMinor}`,
  );

  console.log(`\nFull ledger for this wallet:`);
  const ledger = await wallets.getLedger(wallet.id, { limit: 20 });
  for (const entry of ledger.reverse()) {
    const sign = entry.direction === "credit" ? "+" : "-";
    console.log(
      `  ${entry.createdAt.toISOString()}  ${sign}${naira(entry.amountMinor).replace("-", "")}  (${entry.direction}, tx ${entry.transactionId.slice(0, 8)})`,
    );
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
// Archived pre-migration NestJS/Prisma implementation; excluded from the active build.
