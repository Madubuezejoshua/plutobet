/**
 * Wallet service contract — Phase 1.
 *
 * Implemented by ./wallet.service.ts and ./wallet-reconciliation.service.ts.
 */

export type Minor = bigint;

export type HouseAccount =
  | "cash_in"
  | "cash_out"
  | "stakes_liability"
  | "payouts_payable"
  | "bonus_liability"
  | "adjustments_equity";

export type TransactionType =
  | "deposit"
  | "withdrawal"
  | "stake"
  | "payout"
  | "refund"
  | "bonus"
  | "adjustment"
  | "transfer";

export type ActorType = "user" | "admin" | "system";

export interface Actor {
  type: ActorType;
  /** Required unless type === "system". */
  id?: string;
}

// ---------------------------------------------------------------------------
// Errors — callers branch on these, so they're typed, not string-matched.
// ---------------------------------------------------------------------------

export class WalletNotFoundError extends Error {
  constructor(public readonly walletId: string) {
    super(`wallet not found: ${walletId}`);
    this.name = "WalletNotFoundError";
  }
}

/** Clean rejection — no transaction row, no ledger rows, nothing persisted.
 *  The idempotency key stays available for a legitimate retry. */
export class InsufficientFundsError extends Error {
  constructor(
    public readonly walletId: string,
    public readonly requestedMinor: Minor,
    public readonly availableMinor: Minor,
  ) {
    super(
      `insufficient funds on wallet ${walletId}: requested ${requestedMinor}, available ${availableMinor}`,
    );
    this.name = "InsufficientFundsError";
  }
}

/** Same idempotency key, different amount/wallet/type than the original call.
 *  This is a caller bug (key collision), not a business rejection — never
 *  silently coerced to the original result. */
export class IdempotencyConflictError extends Error {
  constructor(public readonly idempotencyKey: string) {
    super(`idempotency key already used with different parameters: ${idempotencyKey}`);
    this.name = "IdempotencyConflictError";
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface WalletOperationResult {
  transactionId: string;
  /** True if this call resolved to an already-committed transaction
   *  (same idempotency key seen before) rather than doing new work. */
  idempotent: boolean;
  /** Balance of the wallet named in the call (walletId / fromWalletId),
   *  after the operation. Always exact — only ever reported for locked
   *  (user) wallets, which is the only kind a caller can name here. */
  balanceAfterMinor: Minor;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  walletId: string;
  direction: "debit" | "credit";
  amountMinor: Minor;
  balanceAfterMinor: Minor | null; // null for house-wallet legs, see schema notes
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// WalletService — the only path anything is allowed to move money through.
// ---------------------------------------------------------------------------

export interface WalletService {
  /**
   * Debit a user wallet, crediting the given house account as counter-party.
   * Rejects cleanly with InsufficientFundsError if the balance can't cover it.
   */
  debit(params: {
    walletId: string;
    amountMinor: Minor;
    counterparty: HouseAccount;
    type: TransactionType;
    idempotencyKey: string;
    actor: Actor;
    reference?: string;
    metadata?: Record<string, unknown>;
  }): Promise<WalletOperationResult>;

  /** Credit a user wallet, debiting the given house account as counter-party. */
  credit(params: {
    walletId: string;
    amountMinor: Minor;
    counterparty: HouseAccount;
    type: TransactionType;
    idempotencyKey: string;
    actor: Actor;
    reference?: string;
    metadata?: Record<string, unknown>;
  }): Promise<WalletOperationResult>;

  /**
   * Move funds between two user wallets (e.g. admin correction). Both wallets
   * are locked, in a fixed global order (ascending id) regardless of which
   * one is "from", to make deadlock between two opposite-direction transfers
   * impossible.
   */
  transfer(params: {
    fromWalletId: string;
    toWalletId: string;
    amountMinor: Minor;
    type: TransactionType;
    idempotencyKey: string;
    actor: Actor;
    metadata?: Record<string, unknown>;
  }): Promise<WalletOperationResult>;

  /** Reads wallets.cached_balance_minor. Only meaningful for user wallets. */
  getBalance(walletId: string): Promise<Minor>;

  getLedger(walletId: string, opts?: { limit?: number; before?: Date }): Promise<LedgerEntryView[]>;
}

// ---------------------------------------------------------------------------
// Reconciliation — Phase 1's "balance reconstruction job"
// ---------------------------------------------------------------------------

export interface WalletDrift {
  walletId: string;
  cachedMinor: Minor;
  computedMinor: Minor;
  driftMinor: Minor; // computed - cached; nonzero is a page, not a log line
}

export interface WalletReconciliationService {
  /**
   * Replays ledger_entries for one wallet (sum credits - sum debits) and
   * compares to cached_balance_minor. Lock-free: reads (balance, version)
   * before replay and after; if version changed, the wallet was written
   * concurrently and this returns null (retry) instead of a false-positive
   * drift alert.
   */
  reconcileWallet(walletId: string): Promise<WalletDrift | null>;

  /** Runs reconcileWallet over every user wallet; returns only nonzero drift. */
  reconcileAll(): Promise<WalletDrift[]>;
}
// Archived pre-migration NestJS/Prisma implementation; excluded from the active build.
