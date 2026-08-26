import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  Actor,
  HouseAccount,
  IdempotencyConflictError,
  InsufficientFundsError,
  LedgerEntryView,
  Minor,
  TransactionType,
  WalletNotFoundError,
  WalletOperationResult,
  WalletService as WalletServiceContract,
} from "./wallet.types";

type Tx = Prisma.TransactionClient;

/**
 * Postgres-side backstop: if a wallet's FOR UPDATE lock is somehow held for
 * this long (a wedged transaction, a dead connection holding the row), fail
 * loudly instead of queueing every other operation on that wallet forever.
 * Generous on purpose — the 100-concurrent-debit test legitimately queues
 * 100 short transactions on one row, and that queue must never trip this.
 */
const LOCK_TIMEOUT = "30s";

/** Matches LOCK_TIMEOUT — how long Prisma's own interactive-transaction
 *  wrapper will wait before giving up client-side, independent of Postgres's
 *  own lock_timeout above. */
const PRISMA_TX_TIMEOUT_MS = 30_000;

interface MoveParams {
  walletId: string;
  amountMinor: Minor;
  counterparty: HouseAccount;
  type: TransactionType;
  idempotencyKey: string;
  actor: Actor;
  reference?: string;
  metadata?: Record<string, unknown>;
}

interface TransferParams {
  fromWalletId: string;
  toWalletId: string;
  amountMinor: Minor;
  type: TransactionType;
  idempotencyKey: string;
  actor: Actor;
  metadata?: Record<string, unknown>;
}

type CreateOrReplay =
  | { idempotent: false; transaction: { id: string } }
  | { idempotent: true; transaction: { id: string; type: string; idempotencyKey: string } };

@Injectable()
export class WalletService implements WalletServiceContract {
  constructor(private readonly prisma: PrismaService) {}

  async debit(params: MoveParams): Promise<WalletOperationResult> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);

        const replay = await this.tryReplay(tx, params);
        if (replay) return replay;

        const current = await this.lockUserWalletBalance(tx, params.walletId);
        if (current < params.amountMinor) {
          throw new InsufficientFundsError(params.walletId, params.amountMinor, current);
        }
        const next = current - params.amountMinor;

        return this.commitMove(tx, {
          ...params,
          userDirection: "debit",
          houseDirection: "credit",
          newUserBalance: next,
        });
      },
      { timeout: PRISMA_TX_TIMEOUT_MS, maxWait: PRISMA_TX_TIMEOUT_MS },
    );
  }

  async credit(params: MoveParams): Promise<WalletOperationResult> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);

        const replay = await this.tryReplay(tx, params);
        if (replay) return replay;

        const current = await this.lockUserWalletBalance(tx, params.walletId);
        const next = current + params.amountMinor;

        return this.commitMove(tx, {
          ...params,
          userDirection: "credit",
          houseDirection: "debit",
          newUserBalance: next,
        });
      },
      { timeout: PRISMA_TX_TIMEOUT_MS, maxWait: PRISMA_TX_TIMEOUT_MS },
    );
  }

  async transfer(params: TransferParams): Promise<WalletOperationResult> {
    if (params.fromWalletId === params.toWalletId) {
      throw new Error("cannot transfer a wallet to itself");
    }

    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);

        const existing = await tx.transaction.findUnique({
          where: { idempotencyKey: params.idempotencyKey },
        });
        if (existing) {
          return this.replayFor(tx, existing, params.fromWalletId, {
            type: params.type,
            idempotencyKey: params.idempotencyKey,
            amountMinor: params.amountMinor,
          });
        }

        // Lock both rows in a single statement, ascending id. Two concurrent
        // transfers in opposite directions (A->B and B->A) then always
        // acquire their locks in the same order, so they queue instead of
        // deadlocking.
        const ids = [params.fromWalletId, params.toWalletId].sort();
        const locked = await tx.$queryRaw<
          { id: string; cached_balance_minor: bigint | null; kind: string }[]
        >(Prisma.sql`
          SELECT id, cached_balance_minor, kind FROM wallets
          WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
          ORDER BY id
          FOR UPDATE
        `);

        const from = locked.find((w) => w.id === params.fromWalletId);
        const to = locked.find((w) => w.id === params.toWalletId);
        if (!from) throw new WalletNotFoundError(params.fromWalletId);
        if (!to) throw new WalletNotFoundError(params.toWalletId);
        if (from.kind !== "user" || to.kind !== "user") {
          throw new Error("transfer() only moves funds between user wallets");
        }

        const fromBalance = from.cached_balance_minor as bigint;
        if (fromBalance < params.amountMinor) {
          throw new InsufficientFundsError(params.fromWalletId, params.amountMinor, fromBalance);
        }
        const toBalance = to.cached_balance_minor as bigint;
        const newFromBalance = fromBalance - params.amountMinor;
        const newToBalance = toBalance + params.amountMinor;

        const created = await this.createTransactionOrReplay(tx, {
          type: params.type,
          idempotencyKey: params.idempotencyKey,
          actor: params.actor,
          metadata: params.metadata,
        });
        if (created.idempotent) {
          return this.replayFor(tx, created.transaction, params.fromWalletId, {
            type: params.type,
            idempotencyKey: params.idempotencyKey,
            amountMinor: params.amountMinor,
          });
        }

        await tx.ledgerEntry.create({
          data: {
            transactionId: created.transaction.id,
            walletId: params.fromWalletId,
            direction: "debit",
            amountMinor: params.amountMinor,
            balanceAfterMinor: newFromBalance,
          },
        });
        await tx.ledgerEntry.create({
          data: {
            transactionId: created.transaction.id,
            walletId: params.toWalletId,
            direction: "credit",
            amountMinor: params.amountMinor,
            balanceAfterMinor: newToBalance,
          },
        });

        await tx.wallet.update({
          where: { id: params.fromWalletId },
          data: { cachedBalanceMinor: newFromBalance, version: { increment: 1 }, updatedAt: new Date() },
        });
        await tx.wallet.update({
          where: { id: params.toWalletId },
          data: { cachedBalanceMinor: newToBalance, version: { increment: 1 }, updatedAt: new Date() },
        });

        return {
          transactionId: created.transaction.id,
          idempotent: false,
          balanceAfterMinor: newFromBalance,
        };
      },
      { timeout: PRISMA_TX_TIMEOUT_MS, maxWait: PRISMA_TX_TIMEOUT_MS },
    );
  }

  async getBalance(walletId: string): Promise<Minor> {
    const wallet = await this.prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
    if (wallet.cachedBalanceMinor === null) {
      throw new Error(
        `wallet ${walletId} has no cached balance (it's a house wallet) — use WalletReconciliationService to derive one`,
      );
    }
    return wallet.cachedBalanceMinor;
  }

  async getLedger(
    walletId: string,
    opts?: { limit?: number; before?: Date },
  ): Promise<LedgerEntryView[]> {
    const rows = await this.prisma.ledgerEntry.findMany({
      where: {
        walletId,
        ...(opts?.before ? { createdAt: { lt: opts.before } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: opts?.limit ?? 50,
    });
    return rows.map((r) => ({
      id: r.id,
      transactionId: r.transactionId,
      walletId: r.walletId,
      direction: r.direction,
      amountMinor: r.amountMinor,
      balanceAfterMinor: r.balanceAfterMinor,
      createdAt: r.createdAt,
    }));
  }

  // ---------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------

  /** Locks the wallet row and returns its current balance. Throws if the
   *  wallet doesn't exist or isn't a user wallet (house wallets have no
   *  balance to lock — see schema notes). */
  private async lockUserWalletBalance(tx: Tx, walletId: string): Promise<bigint> {
    // NOTE: unverified against a live DB (no Postgres available while writing
    // this) — Prisma is expected to deserialize a raw-query BIGINT column as
    // a JS bigint, not a string. Confirm this once Docker is up; if it comes
    // back as a string, this needs a BigInt(...) wrap.
    const rows = await tx.$queryRaw<
      { id: string; cached_balance_minor: bigint | null; kind: string }[]
    >(Prisma.sql`
      SELECT id, cached_balance_minor, kind FROM wallets WHERE id = ${walletId}::uuid FOR UPDATE
    `);
    if (rows.length === 0) throw new WalletNotFoundError(walletId);
    if (rows[0].kind !== "user" || rows[0].cached_balance_minor === null) {
      throw new Error(`wallet ${walletId} is a house wallet — debit()/credit() only operate on user wallets`);
    }
    return rows[0].cached_balance_minor;
  }

  private async tryReplay(tx: Tx, params: MoveParams): Promise<WalletOperationResult | null> {
    const existing = await tx.transaction.findUnique({
      where: { idempotencyKey: params.idempotencyKey },
    });
    if (!existing) return null;
    return this.replayFor(tx, existing, params.walletId, {
      type: params.type,
      idempotencyKey: params.idempotencyKey,
      amountMinor: params.amountMinor,
    });
  }

  /** Returns the previously-committed result for an idempotency key,
   *  scoped to one wallet's leg of that transaction. Throws
   *  IdempotencyConflictError if the key was reused for a different
   *  operation (caller bug) rather than silently reinterpreting it. */
  private async replayFor(
    tx: Tx,
    existing: { id: string; type: string; idempotencyKey: string },
    walletId: string,
    expected: { type: TransactionType; idempotencyKey: string; amountMinor: Minor },
  ): Promise<WalletOperationResult> {
    if (existing.type !== expected.type) {
      throw new IdempotencyConflictError(expected.idempotencyKey);
    }
    const leg = await tx.ledgerEntry.findFirst({
      where: { transactionId: existing.id, walletId },
    });
    if (!leg || leg.amountMinor !== expected.amountMinor) {
      throw new IdempotencyConflictError(expected.idempotencyKey);
    }
    const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: walletId } });
    const balanceAfter = leg.balanceAfterMinor ?? wallet.cachedBalanceMinor;
    if (balanceAfter === null) {
      throw new Error(`wallet ${walletId} has no recorded balance to replay`);
    }
    return { transactionId: existing.id, idempotent: true, balanceAfterMinor: balanceAfter };
  }

  /** INSERTs the transaction header, or — if a concurrent call with the same
   *  idempotency key won the race between our pre-check and this insert —
   *  reports that so the caller can replay instead of double-writing. */
  private async createTransactionOrReplay(
    tx: Tx,
    input: {
      type: TransactionType;
      idempotencyKey: string;
      reference?: string;
      actor: Actor;
      metadata?: Record<string, unknown>;
    },
  ): Promise<CreateOrReplay> {
    try {
      const created = await tx.transaction.create({
        data: {
          type: input.type,
          idempotencyKey: input.idempotencyKey,
          reference: input.reference,
          actorType: input.actor.type,
          actorId: input.actor.id,
          metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        },
      });
      return { idempotent: false, transaction: created };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const raced = await tx.transaction.findUniqueOrThrow({
          where: { idempotencyKey: input.idempotencyKey },
        });
        return { idempotent: true, transaction: raced };
      }
      throw err;
    }
  }

  private async commitMove(
    tx: Tx,
    args: MoveParams & {
      userDirection: "debit" | "credit";
      houseDirection: "debit" | "credit";
      newUserBalance: bigint;
    },
  ): Promise<WalletOperationResult> {
    const house = await tx.wallet.findFirst({
      where: { kind: "house", houseAccount: args.counterparty },
    });
    if (!house) throw new Error(`unknown house account: ${args.counterparty}`);

    const created = await this.createTransactionOrReplay(tx, {
      type: args.type,
      idempotencyKey: args.idempotencyKey,
      reference: args.reference,
      actor: args.actor,
      metadata: args.metadata,
    });
    if (created.idempotent) {
      return this.replayFor(tx, created.transaction, args.walletId, {
        type: args.type,
        idempotencyKey: args.idempotencyKey,
        amountMinor: args.amountMinor,
      });
    }

    await tx.ledgerEntry.create({
      data: {
        transactionId: created.transaction.id,
        walletId: args.walletId,
        direction: args.userDirection,
        amountMinor: args.amountMinor,
        balanceAfterMinor: args.newUserBalance,
      },
    });
    await tx.ledgerEntry.create({
      data: {
        transactionId: created.transaction.id,
        walletId: house.id,
        direction: args.houseDirection,
        amountMinor: args.amountMinor,
        balanceAfterMinor: null,
      },
    });

    await tx.wallet.update({
      where: { id: args.walletId },
      data: { cachedBalanceMinor: args.newUserBalance, version: { increment: 1 }, updatedAt: new Date() },
    });

    return {
      transactionId: created.transaction.id,
      idempotent: false,
      balanceAfterMinor: args.newUserBalance,
    };
  }
}
// Archived pre-migration NestJS/Prisma implementation; excluded from the active build.
