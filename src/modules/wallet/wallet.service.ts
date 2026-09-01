import { and, desc, eq, lt, sql } from "drizzle-orm";
import { appendAuditLog } from "../audit/append";
import { dbDirect, type DirectDatabase } from "./db-direct";
import {
  AdminAuthorizationError,
  IdempotencyConflictError,
  InsufficientFundsError,
  InvalidActorError,
  InvalidAmountError,
  InvalidIdempotencyKeyError,
  InvalidWalletIdError,
  NonUserWalletError,
  ReferenceConflictError,
  SelfTransferError,
  WalletContentionError,
  WalletNotFoundError,
  WalletOwnershipError,
} from "./errors";
import { operationFingerprint } from "./fingerprint";
import { ledgerEntries, ledgerTransactions, wallets } from "./schema";
import type {
  CreditRequest,
  DebitRequest,
  JsonObject,
  LedgerDirection,
  MoneyActor,
  StatementEntry,
  StatementPage,
  SystemAccount,
  TransferRequest,
  WalletOperationResult,
  WalletServiceContract,
  WalletTransaction,
  WalletTransactionContext,
  WalletTransactionWork,
} from "./types";

/** @deprecated Import WalletTransaction from the public wallet boundary. */
export type DirectTransaction = WalletTransaction;

type LockedWallet = {
  id: string;
  kind: "USER" | "SYSTEM";
  user_id: string | null;
  cached_balance_minor: bigint | null;
  version: bigint;
};

type PreparedOperation = {
  idempotencyKey: string;
  reference?: string;
  fingerprint: string;
  metadata: JsonObject;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADMIN_REAUTH_MAX_AGE_MS = 5 * 60_000;
const ADMIN_REAUTH_FUTURE_SKEW_MS = 30_000;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

const CREDIT_COUNTERPARTY: Record<CreditRequest["type"], SystemAccount> = {
  DEPOSIT: "CASH_IN",
  PAYOUT: "PAYOUTS_PAYABLE",
  REFUND: "STAKES_LIABILITY",
  BONUS: "BONUS_LIABILITY",
  ADJUSTMENT: "ADJUSTMENTS_EQUITY",
};

const DEBIT_COUNTERPARTY: Record<DebitRequest["type"], SystemAccount> = {
  WITHDRAWAL: "CASH_OUT",
  STAKE: "STAKES_LIABILITY",
  ADJUSTMENT: "ADJUSTMENTS_EQUITY",
};

/**
 * The only service allowed to write ledger rows or cached wallet balances.
 *
 * READ COMMITTED plus `SELECT ... FOR UPDATE` is deliberate: once the row
 * lock is acquired, PostgreSQL returns the latest committed wallet version,
 * and every competing debit queues behind it. SERIALIZABLE would add aborts
 * and retries without strengthening this single-row invariant.
 */
export class WalletService implements WalletServiceContract {
  constructor(private readonly database: DirectDatabase = dbDirect) {}

  /**
   * Owns the unpooled transaction used by cross-module money workflows.
   *
   * The callback may write its domain rows through `tx` and must move money
   * only through the supplied closures. All work commits or rolls back as one
   * READ COMMITTED transaction. The context must not escape the callback.
   */
  async withMoneyTransaction<T>(work: WalletTransactionWork<T>): Promise<T> {
    if (typeof work !== "function") throw new TypeError("money transaction work must be a function");

    return this.database.transaction(
      async (tx) => {
        await this.configureTransactionBase(tx);
        const context: WalletTransactionContext = {
          tx,
          debit: (request) => this.debitWithin(tx, request),
          credit: (request) => this.creditWithin(tx, request),
        };
        return work(context);
      },
      { isolationLevel: "read committed", accessMode: "read write" },
    );
  }

  debit(request: DebitRequest): Promise<WalletOperationResult>;
  debit(
    walletId: string,
    amountMinor: bigint,
    type: DebitRequest["type"],
    idempotencyKey: string,
    metadata?: JsonObject,
  ): Promise<WalletOperationResult>;
  async debit(
    requestOrWalletId: DebitRequest | string,
    amountMinor?: bigint,
    type?: DebitRequest["type"],
    idempotencyKey?: string,
    metadata?: JsonObject,
  ): Promise<WalletOperationResult> {
    let request: DebitRequest = typeof requestOrWalletId === "string"
      ? {
          walletId: requestOrWalletId,
          amountMinor: amountMinor as bigint,
          type: type as DebitRequest["type"],
          idempotencyKey: idempotencyKey as string,
          metadata,
          actor: { type: "SYSTEM" },
        }
      : requestOrWalletId;
    request = {
      ...request,
      walletId: this.normalizeWalletId(request.walletId),
      actor: this.normalizeActor(request.actor),
    };
    this.validateMove(request);
    const counterparty = DEBIT_COUNTERPARTY[request.type];
    if (!counterparty) throw new RangeError(`unsupported debit transaction type: ${String(request.type)}`);
    const prepared = this.prepareOperation({
      operation: "DEBIT",
      walletId: request.walletId,
      amountMinor: request.amountMinor.toString(),
      type: request.type,
      counterparty,
      reference: request.reference ?? null,
      metadata: request.metadata ?? {},
      actor: this.semanticActor(request.actor),
    }, request);

    return this.database.transaction(
      (tx) => this.applyDebit(tx, request, prepared, counterparty),
      { isolationLevel: "read committed", accessMode: "read write" },
    );
  }

  /**
   * Debit inside a transaction the caller already owns.
   *
   * This exists for bet placement, where the stake debit and the bet rows must
   * commit or roll back as one unit (INVARIANT 8) while the ledger write stays
   * inside this module (INVARIANT 6). Without it a caller could only choose
   * which of those two invariants to break.
   *
   * Identical guarantees to `debit()` — same row lock, same idempotency
   * replay, same audit row, same transaction — because both delegate to
   * `applyDebit`. The one difference is who opens the transaction, so the
   * CALLER is responsible for using `dbDirect`: on Neon's pooled endpoint
   * pgBouncer silently breaks the `FOR UPDATE` this depends on.
   */
  async debitWithin(
    tx: DirectTransaction,
    request: DebitRequest,
  ): Promise<WalletOperationResult> {
    const normalized: DebitRequest = {
      ...request,
      walletId: this.normalizeWalletId(request.walletId),
      actor: this.normalizeActor(request.actor),
    };
    this.validateMove(normalized);
    const counterparty = DEBIT_COUNTERPARTY[normalized.type];
    if (!counterparty) {
      throw new RangeError(`unsupported debit transaction type: ${String(normalized.type)}`);
    }
    const prepared = this.prepareOperation({
      operation: "DEBIT",
      walletId: normalized.walletId,
      amountMinor: normalized.amountMinor.toString(),
      type: normalized.type,
      counterparty,
      reference: normalized.reference ?? null,
      metadata: normalized.metadata ?? {},
      actor: this.semanticActor(normalized.actor),
    }, normalized);

    return this.applyDebit(tx, normalized, prepared, counterparty);
  }

  private async applyDebit(
    tx: DirectTransaction,
    request: DebitRequest,
    prepared: PreparedOperation,
    counterparty: SystemAccount,
  ): Promise<WalletOperationResult> {
    await this.configureMoneyTransaction(tx, prepared);
    const locked = await this.lockUserWallet(tx, request.walletId);
    this.assertActorOwnsWallet(request.actor, locked);

    const replay = await this.replayIfPresent(tx, prepared, request.walletId);
    if (replay) return replay;

    if (locked.cached_balance_minor < request.amountMinor) {
      throw new InsufficientFundsError(
        request.walletId,
        request.amountMinor,
        locked.cached_balance_minor,
      );
    }

    return this.postMove(tx, {
      request,
      prepared,
      counterparty,
      userDirection: "DEBIT",
      systemDirection: "CREDIT",
      balanceBeforeMinor: locked.cached_balance_minor,
      balanceAfterMinor: locked.cached_balance_minor - request.amountMinor,
      walletVersion: locked.version + 1n,
    });
  }

  credit(request: CreditRequest): Promise<WalletOperationResult>;
  credit(
    walletId: string,
    amountMinor: bigint,
    type: CreditRequest["type"],
    idempotencyKey: string,
    metadata?: JsonObject,
  ): Promise<WalletOperationResult>;
  async credit(
    requestOrWalletId: CreditRequest | string,
    amountMinor?: bigint,
    type?: CreditRequest["type"],
    idempotencyKey?: string,
    metadata?: JsonObject,
  ): Promise<WalletOperationResult> {
    let request: CreditRequest = typeof requestOrWalletId === "string"
      ? {
          walletId: requestOrWalletId,
          amountMinor: amountMinor as bigint,
          type: type as CreditRequest["type"],
          idempotencyKey: idempotencyKey as string,
          metadata,
          actor: { type: "SYSTEM" },
        }
      : requestOrWalletId;
    request = {
      ...request,
      walletId: this.normalizeWalletId(request.walletId),
      actor: this.normalizeActor(request.actor),
    };
    this.validateMove(request);
    const counterparty = CREDIT_COUNTERPARTY[request.type];
    if (!counterparty) throw new RangeError(`unsupported credit transaction type: ${String(request.type)}`);
    const prepared = this.prepareOperation({
      operation: "CREDIT",
      walletId: request.walletId,
      amountMinor: request.amountMinor.toString(),
      type: request.type,
      counterparty,
      reference: request.reference ?? null,
      metadata: request.metadata ?? {},
      actor: this.semanticActor(request.actor),
    }, request);

    return this.database.transaction(
      (tx) => this.applyCredit(tx, request, prepared, counterparty),
      { isolationLevel: "read committed", accessMode: "read write" },
    );
  }

  /** Credit inside a transaction owned by `withMoneyTransaction`. */
  async creditWithin(
    tx: DirectTransaction,
    request: CreditRequest,
  ): Promise<WalletOperationResult> {
    const normalized: CreditRequest = {
      ...request,
      walletId: this.normalizeWalletId(request.walletId),
      actor: this.normalizeActor(request.actor),
    };
    this.validateMove(normalized);
    const counterparty = CREDIT_COUNTERPARTY[normalized.type];
    if (!counterparty) {
      throw new RangeError(`unsupported credit transaction type: ${String(normalized.type)}`);
    }
    const prepared = this.prepareOperation({
      operation: "CREDIT",
      walletId: normalized.walletId,
      amountMinor: normalized.amountMinor.toString(),
      type: normalized.type,
      counterparty,
      reference: normalized.reference ?? null,
      metadata: normalized.metadata ?? {},
      actor: this.semanticActor(normalized.actor),
    }, normalized);

    return this.applyCredit(tx, normalized, prepared, counterparty);
  }

  private async applyCredit(
    tx: DirectTransaction,
    request: CreditRequest,
    prepared: PreparedOperation,
    counterparty: SystemAccount,
  ): Promise<WalletOperationResult> {
    await this.configureMoneyTransaction(tx, prepared);
    const locked = await this.lockUserWallet(tx, request.walletId);
    this.assertActorOwnsWallet(request.actor, locked);

    const replay = await this.replayIfPresent(tx, prepared, request.walletId);
    if (replay) return replay;

    return this.postMove(tx, {
      request,
      prepared,
      counterparty,
      userDirection: "CREDIT",
      systemDirection: "DEBIT",
      balanceBeforeMinor: locked.cached_balance_minor,
      balanceAfterMinor: locked.cached_balance_minor + request.amountMinor,
      walletVersion: locked.version + 1n,
    });
  }

  transfer(request: TransferRequest): Promise<WalletOperationResult>;
  transfer(
    fromWalletId: string,
    toWalletId: string,
    amountMinor: bigint,
    idempotencyKey: string,
  ): Promise<WalletOperationResult>;
  async transfer(
    requestOrFromWalletId: TransferRequest | string,
    toWalletId?: string,
    amountMinor?: bigint,
    idempotencyKey?: string,
  ): Promise<WalletOperationResult> {
    let request: TransferRequest = typeof requestOrFromWalletId === "string"
      ? {
          fromWalletId: requestOrFromWalletId,
          toWalletId: toWalletId as string,
          amountMinor: amountMinor as bigint,
          idempotencyKey: idempotencyKey as string,
          actor: { type: "SYSTEM" },
        }
      : requestOrFromWalletId;
    request = {
      ...request,
      fromWalletId: this.normalizeWalletId(request.fromWalletId),
      toWalletId: this.normalizeWalletId(request.toWalletId),
      actor: this.normalizeActor(request.actor),
    };
    this.validateTransfer(request);
    const prepared = this.prepareOperation({
      operation: "TRANSFER",
      fromWalletId: request.fromWalletId,
      toWalletId: request.toWalletId,
      amountMinor: request.amountMinor.toString(),
      type: "TRANSFER",
      reference: request.reference ?? null,
      metadata: request.metadata ?? {},
      actor: this.semanticActor(request.actor),
    }, request);

    return this.database.transaction(
      async (tx) => {
        await this.configureMoneyTransaction(tx, prepared);
        const locked = await tx.execute<LockedWallet>(sql`
          SELECT id, kind, user_id, cached_balance_minor, version
          FROM wallets
          WHERE id IN (${request.fromWalletId}::uuid, ${request.toWalletId}::uuid)
          ORDER BY id
          FOR UPDATE
        `);

        const from = locked.find((wallet) => wallet.id === request.fromWalletId);
        const to = locked.find((wallet) => wallet.id === request.toWalletId);
        if (!from) throw new WalletNotFoundError(request.fromWalletId);
        if (!to) throw new WalletNotFoundError(request.toWalletId);
        if (from.kind !== "USER" || from.cached_balance_minor === null) {
          throw new NonUserWalletError(request.fromWalletId);
        }
        if (to.kind !== "USER" || to.cached_balance_minor === null) {
          throw new NonUserWalletError(request.toWalletId);
        }
        this.assertActorOwnsWallet(request.actor, from);

        const replay = await this.replayIfPresent(
          tx,
          prepared,
          request.fromWalletId,
        );
        if (replay) return replay;

        if (from.cached_balance_minor < request.amountMinor) {
          throw new InsufficientFundsError(
            request.fromWalletId,
            request.amountMinor,
            from.cached_balance_minor,
          );
        }

        const fromAfter = from.cached_balance_minor - request.amountMinor;
        const toAfter = to.cached_balance_minor + request.amountMinor;
        const fromVersion = from.version + 1n;
        const toVersion = to.version + 1n;
        const transactionId = await this.insertTransaction(tx, {
          prepared,
          type: "TRANSFER",
          actor: request.actor,
        });

        await tx.insert(ledgerEntries).values([
          {
            txnId: transactionId,
            walletId: request.fromWalletId,
            direction: "DEBIT",
            amountMinor: request.amountMinor,
            balanceAfterMinor: fromAfter,
            walletVersion: fromVersion,
          },
          {
            txnId: transactionId,
            walletId: request.toWalletId,
            direction: "CREDIT",
            amountMinor: request.amountMinor,
            balanceAfterMinor: toAfter,
            walletVersion: toVersion,
          },
        ]);

        await tx
          .update(wallets)
          .set({
            cachedBalanceMinor: fromAfter,
            version: fromVersion,
            updatedAt: new Date(),
          })
          .where(eq(wallets.id, request.fromWalletId));
        await tx
          .update(wallets)
          .set({
            cachedBalanceMinor: toAfter,
            version: toVersion,
            updatedAt: new Date(),
          })
          .where(eq(wallets.id, request.toWalletId));

        await appendAuditLog(tx, {
          actorType: request.actor.type,
          actorId: this.actorId(request.actor),
          action: "WALLET_TRANSFER",
          entity: "LEDGER_TRANSACTION",
          entityId: transactionId,
          before: {
            fromWalletId: request.fromWalletId,
            fromBalanceMinor: from.cached_balance_minor.toString(),
            toWalletId: request.toWalletId,
            toBalanceMinor: to.cached_balance_minor.toString(),
          },
          after: {
            fromBalanceMinor: fromAfter.toString(),
            toBalanceMinor: toAfter.toString(),
            amountMinor: request.amountMinor.toString(),
          },
          ip: request.actor.ip,
          reason: request.actor.type === "ADMIN" ? request.actor.reason : null,
        });

        return {
          transactionId,
          idempotent: false,
          balanceAfterMinor: fromAfter,
        };
      },
      { isolationLevel: "read committed", accessMode: "read write" },
    );
  }

  async getBalance(walletId: string): Promise<bigint> {
    walletId = this.normalizeWalletId(walletId);
    return this.database.transaction(
      async (tx) => {
        await tx.execute(sql.raw("SET LOCAL ROLE app_role"));
        const [wallet] = await tx
          .select({ kind: wallets.kind, balance: wallets.cachedBalanceMinor })
          .from(wallets)
          .where(eq(wallets.id, walletId))
          .limit(1);
        if (!wallet) throw new WalletNotFoundError(walletId);
        if (wallet.kind !== "USER" || wallet.balance === null) {
          throw new NonUserWalletError(walletId);
        }
        return wallet.balance;
      },
      { isolationLevel: "read committed", accessMode: "read only" },
    );
  }

  async getStatement(
    walletId: string,
    pagination: { limit?: number; before?: { walletVersion: bigint } } = {},
  ): Promise<StatementPage> {
    walletId = this.normalizeWalletId(walletId);
    const limit = pagination.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("statement limit must be an integer between 1 and 100");
    }
    if (pagination.before && pagination.before.walletVersion <= 0n) {
      throw new RangeError("statement cursor walletVersion must be positive");
    }

    return this.database.transaction(
      async (tx) => {
        await tx.execute(sql.raw("SET LOCAL ROLE app_role"));
        const [wallet] = await tx
          .select({ kind: wallets.kind })
          .from(wallets)
          .where(eq(wallets.id, walletId))
          .limit(1);
        if (!wallet) throw new WalletNotFoundError(walletId);
        if (wallet.kind !== "USER") throw new NonUserWalletError(walletId);

        const cursor = pagination.before;
        const rows = await tx
          .select({
            id: ledgerEntries.id,
            transactionId: ledgerEntries.txnId,
            direction: ledgerEntries.direction,
            amountMinor: ledgerEntries.amountMinor,
            balanceAfterMinor: ledgerEntries.balanceAfterMinor,
            walletVersion: ledgerEntries.walletVersion,
            type: ledgerTransactions.type,
            reference: ledgerTransactions.reference,
            metadata: ledgerTransactions.metadata,
            actorType: ledgerTransactions.actorType,
            actorId: ledgerTransactions.actorId,
            createdAt: ledgerEntries.createdAt,
          })
          .from(ledgerEntries)
          .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.txnId))
          .where(
            and(
              eq(ledgerEntries.walletId, walletId),
              cursor ? lt(ledgerEntries.walletVersion, cursor.walletVersion) : undefined,
            ),
          )
          .orderBy(desc(ledgerEntries.walletVersion))
          .limit(limit + 1);

        const hasMore = rows.length > limit;
        const pageRows = hasMore ? rows.slice(0, limit) : rows;
        const entries: StatementEntry[] = pageRows.map((row) => {
          if (row.balanceAfterMinor === null || row.walletVersion === null) {
            throw new NonUserWalletError(walletId);
          }
          return {
            ...row,
            metadata: row.metadata as JsonObject,
            balanceAfterMinor: row.balanceAfterMinor,
            walletVersion: row.walletVersion,
          };
        });
        const last = entries.at(-1);

        return {
          entries,
          nextCursor: hasMore && last
            ? { walletVersion: last.walletVersion }
            : null,
        };
      },
      { isolationLevel: "read committed", accessMode: "read only" },
    );
  }

  private async postMove(
    tx: DirectTransaction,
    input: {
      request: CreditRequest | DebitRequest;
      prepared: PreparedOperation;
      counterparty: SystemAccount;
      userDirection: LedgerDirection;
      systemDirection: LedgerDirection;
      balanceBeforeMinor: bigint;
      balanceAfterMinor: bigint;
      walletVersion: bigint;
    },
  ): Promise<WalletOperationResult> {
    const [systemWallet] = await tx
      .select({ id: wallets.id })
      .from(wallets)
      .where(
        and(
          eq(wallets.kind, "SYSTEM"),
          eq(wallets.systemAccount, input.counterparty),
          eq(wallets.currency, "NGN"),
        ),
      )
      .limit(1);
    if (!systemWallet) {
      throw new Error(`system counterparty wallet is missing: ${input.counterparty}`);
    }

    const transactionId = await this.insertTransaction(tx, {
      prepared: input.prepared,
      type: input.request.type,
      actor: input.request.actor,
    });

    await tx.insert(ledgerEntries).values([
      {
        txnId: transactionId,
        walletId: input.request.walletId,
        direction: input.userDirection,
        amountMinor: input.request.amountMinor,
        balanceAfterMinor: input.balanceAfterMinor,
        walletVersion: input.walletVersion,
      },
      {
        txnId: transactionId,
        walletId: systemWallet.id,
        direction: input.systemDirection,
        amountMinor: input.request.amountMinor,
        balanceAfterMinor: null,
      },
    ]);

    await tx
      .update(wallets)
      .set({
        cachedBalanceMinor: input.balanceAfterMinor,
        version: input.walletVersion,
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, input.request.walletId));

    await appendAuditLog(tx, {
      actorType: input.request.actor.type,
      actorId: this.actorId(input.request.actor),
      action: `WALLET_${input.userDirection}`,
      entity: "WALLET",
      entityId: input.request.walletId,
      before: { balanceMinor: input.balanceBeforeMinor.toString() },
      after: {
        balanceMinor: input.balanceAfterMinor.toString(),
        amountMinor: input.request.amountMinor.toString(),
        transactionId,
        transactionType: input.request.type,
      },
      ip: input.request.actor.ip,
      reason: input.request.actor.type === "ADMIN" ? input.request.actor.reason : null,
    });

    return {
      transactionId,
      idempotent: false,
      balanceAfterMinor: input.balanceAfterMinor,
    };
  }

  private async insertTransaction(
    tx: DirectTransaction,
    input: {
      prepared: PreparedOperation;
      type: CreditRequest["type"] | DebitRequest["type"] | "TRANSFER";
      actor: MoneyActor;
    },
  ): Promise<string> {
    const [created] = await tx
      .insert(ledgerTransactions)
      .values({
        type: input.type,
        reference: input.prepared.reference,
        idempotencyKey: input.prepared.idempotencyKey,
        requestFingerprint: input.prepared.fingerprint,
        actorType: input.actor.type,
        actorId: this.actorId(input.actor),
        metadata: input.prepared.metadata,
      })
      .returning({ id: ledgerTransactions.id });
    if (!created) throw new Error("ledger transaction insert returned no id");
    return created.id;
  }

  private async configureMoneyTransaction(
    tx: DirectTransaction,
    prepared: PreparedOperation,
  ): Promise<void> {
    await this.configureTransactionBase(tx);

    // PostgreSQL advisory locks make the check-then-insert idempotency path
    // safe across serverless instances. Locks are ordered to avoid a cycle
    // when an external reference and idempotency key are reused together.
    const lockKeys = [`idempotency:${prepared.idempotencyKey}`];
    if (prepared.reference) lockKeys.push(`reference:${prepared.reference}`);
    for (const key of lockKeys.sort()) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    }

    if (prepared.reference) {
      const [byReference] = await tx
        .select({ idempotencyKey: ledgerTransactions.idempotencyKey })
        .from(ledgerTransactions)
        .where(eq(ledgerTransactions.reference, prepared.reference))
        .limit(1);
      if (byReference && byReference.idempotencyKey !== prepared.idempotencyKey) {
        throw new ReferenceConflictError(prepared.reference);
      }
    }
  }

  /**
   * How long a money transaction waits for a wallet row lock.
   *
   * Configurable because the right value is environment-specific: a serverless
   * invocation with a 60s ceiling should not spend 30s of it queuing, while a
   * background job can afford to wait. Overriding it also lets the contention
   * path be tested in milliseconds instead of half a minute.
   *
   * Validated against a strict pattern rather than interpolated: this string
   * goes into SET LOCAL, which takes no parameters, so an unchecked value
   * would be a SQL injection through an environment variable.
   */
  private static lockTimeout(): string {
    const configured = process.env.WALLET_LOCK_TIMEOUT?.trim();
    return configured && /^\d{1,6}(ms|s)$/.test(configured) ? configured : "30s";
  }

  private async configureTransactionBase(tx: DirectTransaction): Promise<void> {
    await tx.execute(sql.raw("SET LOCAL ROLE app_role"));
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${WalletService.lockTimeout()}'`));
  }

  private async replayIfPresent(
    tx: DirectTransaction,
    prepared: PreparedOperation,
    resultWalletId: string,
  ): Promise<WalletOperationResult | null> {
    const [existing] = await tx
      .select({
        id: ledgerTransactions.id,
        fingerprint: ledgerTransactions.requestFingerprint,
      })
      .from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, prepared.idempotencyKey))
      .limit(1);
    if (!existing) return null;
    if (existing.fingerprint !== prepared.fingerprint) {
      throw new IdempotencyConflictError(prepared.idempotencyKey);
    }

    const [leg] = await tx
      .select({ balanceAfterMinor: ledgerEntries.balanceAfterMinor })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.txnId, existing.id),
          eq(ledgerEntries.walletId, resultWalletId),
        ),
      )
      .limit(1);
    if (!leg || leg.balanceAfterMinor === null) {
      throw new IdempotencyConflictError(prepared.idempotencyKey);
    }

    return {
      transactionId: existing.id,
      idempotent: true,
      balanceAfterMinor: leg.balanceAfterMinor,
    };
  }

  /**
   * PostgreSQL codes meaning "could not take the lock", not "the data is wrong".
   *
   * 55P03 is lock_not_available, raised when the `SET LOCAL lock_timeout` set
   * in configureTransactionBase expires waiting on FOR UPDATE. 40P01 is a
   * deadlock, which the server resolves by aborting one side. Both leave
   * NOTHING written, so both are safe for the caller to retry.
   */
  private static readonly CONTENTION_CODES = new Set(["55P03", "40P01"]);

  /**
   * Finds a contention code anywhere in the cause chain.
   *
   * Drizzle wraps driver failures in its own Error ("Failed query: …") and
   * hangs the postgres error off `cause`, so reading `.code` from the thrown
   * object alone finds nothing and every lock timeout stays unmapped. The
   * chain is walked with a depth cap because `cause` is author-controlled and
   * a cycle here would hang the request rather than fail it.
   */
  private static contentionCode(error: unknown): string | null {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && WalletService.CONTENTION_CODES.has(code)) return code;
      current = (current as { cause?: unknown }).cause;
    }
    return null;
  }

  private async lockUserWallet(tx: DirectTransaction, walletId: string): Promise<LockedWallet & { cached_balance_minor: bigint }> {
    let rows: LockedWallet[];
    try {
      rows = await tx.execute<LockedWallet>(sql`
        SELECT id, kind, user_id, cached_balance_minor, version
        FROM wallets
        WHERE id = ${walletId}::uuid
        FOR UPDATE
      `);
    } catch (error) {
      /*
       * A lock timeout used to escape as a raw driver error and reach the API
       * as an opaque 500, so a customer placing a bet during a burst was told
       * nothing useful and no caller could distinguish "try again in a moment"
       * from a real fault. It is an expected outcome under contention, so it
       * gets a type callers can act on.
       */
      const code = WalletService.contentionCode(error);
      if (code) throw new WalletContentionError(walletId, code);
      throw error;
    }

    const wallet = rows[0];
    if (!wallet) throw new WalletNotFoundError(walletId);
    if (wallet.kind !== "USER" || wallet.cached_balance_minor === null) {
      throw new NonUserWalletError(walletId);
    }
    return wallet as LockedWallet & { cached_balance_minor: bigint };
  }

  private assertActorOwnsWallet(actor: MoneyActor, wallet: LockedWallet): void {
    if (actor.type === "USER" && wallet.user_id !== actor.id) {
      throw new WalletOwnershipError(actor.id, wallet.id);
    }
  }

  private prepareOperation(
    semanticInput: Record<string, unknown>,
    request: {
      idempotencyKey: string;
      reference?: string;
      metadata?: JsonObject;
    },
  ): PreparedOperation {
    if (
      typeof request.idempotencyKey !== "string" ||
      request.idempotencyKey.trim().length < 1 ||
      request.idempotencyKey.length > 200
    ) {
      throw new InvalidIdempotencyKeyError();
    }
    if (request.reference !== undefined && (request.reference.length < 1 || request.reference.length > 200)) {
      throw new RangeError("reference must contain between 1 and 200 characters");
    }

    return {
      idempotencyKey: request.idempotencyKey,
      reference: request.reference,
      metadata: request.metadata ?? {},
      fingerprint: operationFingerprint(semanticInput),
    };
  }

  private validateMove(request: CreditRequest | DebitRequest): void {
    this.validateWalletId(request.walletId);
    this.validateAmount(request.amountMinor);
    this.validateActor(request.actor);
  }

  private validateTransfer(request: TransferRequest): void {
    this.validateWalletId(request.fromWalletId);
    this.validateWalletId(request.toWalletId);
    if (request.fromWalletId === request.toWalletId) throw new SelfTransferError();
    this.validateAmount(request.amountMinor);
    this.validateActor(request.actor);
  }

  private validateWalletId(walletId: string): void {
    if (!UUID_PATTERN.test(walletId)) throw new InvalidWalletIdError(walletId);
  }

  private normalizeWalletId(walletId: string): string {
    this.validateWalletId(walletId);
    return walletId.toLowerCase();
  }

  private validateAmount(amountMinor: bigint): void {
    if (
      typeof amountMinor !== "bigint" ||
      amountMinor <= 0n ||
      amountMinor > POSTGRES_BIGINT_MAX
    ) {
      throw new InvalidAmountError(amountMinor);
    }
  }

  private validateActor(actor: MoneyActor): void {
    if (!actor || typeof actor !== "object" || !Object.hasOwn(actor, "type")) {
      throw new InvalidActorError("money movement actor is required");
    }
    if (actor.type !== "SYSTEM" && actor.type !== "USER" && actor.type !== "ADMIN") {
      throw new InvalidActorError("money movement actor type is invalid");
    }
    if (actor.type !== "SYSTEM") {
      this.validateWalletId(actor.id);
      if (typeof actor.ip !== "string" || actor.ip.trim().length === 0) {
        throw new InvalidActorError("user and admin money movements require an IP address");
      }
    }
    if (actor.type !== "ADMIN") return;

    if (
      typeof actor.reason !== "string" ||
      actor.reason.trim().length < 3 ||
      actor.reason.length > 500
    ) {
      throw new AdminAuthorizationError("admin money movements require a 3-500 character reason");
    }
    if (!(actor.reauthenticatedAt instanceof Date)) {
      throw new AdminAuthorizationError("admin money movements require reauthentication evidence");
    }
    const age = Date.now() - actor.reauthenticatedAt.getTime();
    if (!Number.isFinite(age) || age > ADMIN_REAUTH_MAX_AGE_MS || age < -ADMIN_REAUTH_FUTURE_SKEW_MS) {
      throw new AdminAuthorizationError("admin reauthentication is missing, stale, or in the future");
    }
  }

  private normalizeActor(actor: MoneyActor): MoneyActor {
    this.validateActor(actor);
    if (actor.type === "SYSTEM") return actor;
    return { ...actor, id: this.normalizeWalletId(actor.id) };
  }

  private actorId(actor: MoneyActor): string | null {
    return actor.type === "SYSTEM" ? null : actor.id;
  }

  private semanticActor(actor: MoneyActor): Record<string, unknown> {
    return {
      type: actor.type,
      id: this.actorId(actor),
      reason: actor.type === "ADMIN" ? actor.reason : null,
    };
  }
}

export const walletService = new WalletService();
