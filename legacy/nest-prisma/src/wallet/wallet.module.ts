import { Module } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { WalletService } from "./wallet.service";
import { WalletReconciliationService } from "./wallet-reconciliation.service";

@Module({
  providers: [PrismaService, WalletService, WalletReconciliationService],
  exports: [WalletService, WalletReconciliationService],
})
export class WalletModule {}
// Archived pre-migration NestJS/Prisma implementation; excluded from the active build.
