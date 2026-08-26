import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { WalletDrift, WalletReconciliationService as Contract } from "./wallet.types";

@Injectable()
export class WalletReconciliationService implements Contract {
  constructor(private readonly prisma: PrismaService) {}

  async reconcileWallet(walletId: string): Promise<WalletDrift | null> {
    const before = await this.prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
    if (before.kind !== "user" || before.cachedBalanceMinor === null) {
      throw new Error(`reconcileWallet() only applies to user wallets; ${walletId} is ${before.kind}`);
    }

    const sums = await this.prisma.ledgerEntry.groupBy({
      by: ["direction"],
      where: { walletId },
      _sum: { amountMinor: true },
    });
    const credits = sums.find((s) => s.direction === "credit")?._sum.amountMinor ?? 0n;
    const debits = sums.find((s) => s.direction === "debit")?._sum.amountMinor ?? 0n;
    const computed = credits - debits;

    // Lock-free by design — reconciliation runs over every wallet
    // periodically and must not hold FOR UPDATE locks that would contend
    // with live traffic. Instead: re-read version after summing: if it
    // moved, this wallet was written to mid-replay, so the comparison below
    // would be against a stale snapshot. Report "retry me" instead of a
    // false-positive drift alert.
    const after = await this.prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
    if (after.version !== before.version) return null;

    const cached = before.cachedBalanceMinor;
    return {
      walletId,
      cachedMinor: cached,
      computedMinor: computed,
      driftMinor: computed - cached,
    };
  }

  async reconcileAll(): Promise<WalletDrift[]> {
    const userWallets = await this.prisma.wallet.findMany({
      where: { kind: "user" },
      select: { id: true },
    });
    const drifts: WalletDrift[] = [];
    for (const w of userWallets) {
      const result = await this.reconcileWallet(w.id);
      if (result && result.driftMinor !== 0n) drifts.push(result);
    }
    return drifts;
  }
}
// Archived pre-migration NestJS/Prisma implementation; excluded from the active build.
