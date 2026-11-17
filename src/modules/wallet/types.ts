export const LEDGER_TRANSACTION_TYPES = [
  "DEPOSIT",
  "WITHDRAWAL",
  "STAKE",
  "PAYOUT",
  "REFUND",
  "BONUS",
  "ADJUSTMENT",
  "TRANSFER",
] as const;

export const LEDGER_DIRECTIONS = ["DEBIT", "CREDIT"] as const;
export const WALLET_KINDS = ["USER", "SYSTEM"] as const;
export const WALLET_CURRENCIES = ["NGN"] as const;
export const SYSTEM_ACCOUNTS = [
  "CASH_IN",
  "CASH_OUT",
  "STAKES_LIABILITY",
  "PAYOUTS_PAYABLE",
  "BONUS_LIABILITY",
  "ADJUSTMENTS_EQUITY",
] as const;
export const RECONCILIATION_STATUSES = ["CLEAN", "FLAGGED"] as const;

export type LedgerTransactionType = (typeof LEDGER_TRANSACTION_TYPES)[number];
export type LedgerDirection = (typeof LEDGER_DIRECTIONS)[number];
export type SystemAccount = (typeof SYSTEM_ACCOUNTS)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type SystemActor = {
  type: "SYSTEM";
  ip?: string;
};

export type UserActor = {
  type: "USER";
  id: string;
  ip: string;
};

export type AdminActor = {
  type: "ADMIN";
  id: string;
  ip: string;
  /** Required for every admin-initiated money movement. */
  reason: string;
  /** The service rejects stale reauthentication evidence. */
  reauthenticatedAt: Date;
};

export type MoneyActor = SystemActor | UserActor | AdminActor;

type MoveRequest = {
  walletId: string;
  amountMinor: bigint;
  idempotencyKey: string;
  actor: MoneyActor;
  reference?: string;
  metadata?: JsonObject;
};

export type CreditRequest = MoveRequest & {
  type: Extract<LedgerTransactionType, "DEPOSIT" | "PAYOUT" | "REFUND" | "BONUS" | "ADJUSTMENT">;
};

export type DebitRequest = MoveRequest & {
  type: Extract<LedgerTransactionType, "WITHDRAWAL" | "STAKE" | "ADJUSTMENT">;
};

export type TransferRequest = {
  fromWalletId: string;
  toWalletId: string;
  amountMinor: bigint;
  idempotencyKey: string;
  actor: MoneyActor;
  reference?: string;
  metadata?: JsonObject;
};

export type WalletOperationResult = {
  transactionId: string;
  idempotent: boolean;
  balanceAfterMinor: bigint;
};

/**
 * Opaque-to-callers transaction shape owned by the wallet module.
 *
 * Domain modules receive this through `withMoneyTransaction`; they never need
 * to import the direct client (or any ledger table) themselves.
 */
export type WalletTransaction = Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0];

export type WalletTransactionContext = {
  /** Use for domain rows that must commit atomically with the money movement. */
  readonly tx: WalletTransaction;
  debit(request: DebitRequest): Promise<WalletOperationResult>;
  credit(request: CreditRequest): Promise<WalletOperationResult>;
};

export type WalletTransactionWork<T> = (
  context: WalletTransactionContext,
) => Promise<T>;

export type StatementCursor = {
  walletVersion: bigint;
};

export type StatementEntry = {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  amountMinor: bigint;
  balanceAfterMinor: bigint;
  walletVersion: bigint;
  type: LedgerTransactionType;
  reference: string | null;
  metadata: JsonObject;
  actorType: MoneyActor["type"];
  actorId: string | null;
  createdAt: Date;
};

export type StatementPage = {
  entries: StatementEntry[];
  nextCursor: StatementCursor | null;
};

export type WalletDrift = {
  walletId: string;
  cachedMinor: bigint;
  computedMinor: bigint;
  driftMinor: bigint;
  status: "CLEAN" | "FLAGGED";
  issues: string[];
};

export interface WalletServiceContract {
  withMoneyTransaction<T>(work: WalletTransactionWork<T>): Promise<T>;
  credit(request: CreditRequest): Promise<WalletOperationResult>;
  credit(
    walletId: string,
    amountMinor: bigint,
    type: CreditRequest["type"],
    idempotencyKey: string,
    metadata?: JsonObject,
  ): Promise<WalletOperationResult>;
  debit(request: DebitRequest): Promise<WalletOperationResult>;
  debit(
    walletId: string,
    amountMinor: bigint,
    type: DebitRequest["type"],
    idempotencyKey: string,
    metadata?: JsonObject,
  ): Promise<WalletOperationResult>;
  transfer(request: TransferRequest): Promise<WalletOperationResult>;
  transfer(
    fromWalletId: string,
    toWalletId: string,
    amountMinor: bigint,
    idempotencyKey: string,
  ): Promise<WalletOperationResult>;
  getBalance(walletId: string): Promise<bigint>;
  getStatement(
    walletId: string,
    pagination?: { limit?: number; before?: StatementCursor },
  ): Promise<StatementPage>;
}
import type { DirectDatabase } from "./db-direct";
