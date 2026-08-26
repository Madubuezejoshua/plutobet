import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { WalletService } from "./wallet.service";
import { WalletReconciliationService } from "./wallet-reconciliation.service";

export function makeTestContext() {
  const prisma = new PrismaService();
  const wallets = new WalletService(prisma);
  const reconciliation = new WalletReconciliationService(prisma);
  return { prisma, wallets, reconciliation };
}

export async function fundedUserWallet(prisma: PrismaService, balanceMinor: bigint): Promise<string> {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@test.local` } });
  const wallet = await prisma.wallet.create({
    data: {
      kind: "user",
      userId: user.id,
      currency: "NGN",
      cachedBalanceMinor: balanceMinor,
    },
  });
  return wallet.id;
}
// Archived pre-migration NestJS/Prisma implementation; excluded from the active build.
