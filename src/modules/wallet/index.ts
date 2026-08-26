/**
 * Public wallet-module boundary.
 *
 * Ledger schemas and the direct database client are intentionally not
 * re-exported. Other modules move money only through this service contract.
 */
export { WalletService, walletService } from "./wallet.service";
export {
  AdminAuthorizationError,
  IdempotencyConflictError,
  InsufficientFundsError,
  InvalidActorError,
  InvalidAmountError,
  InvalidIdempotencyKeyError,
  InvalidMetadataError,
  InvalidWalletIdError,
  NonUserWalletError,
  ReferenceConflictError,
  SelfTransferError,
  WalletError,
  WalletNotFoundError,
  WalletOwnershipError,
} from "./errors";
export type {
  CreditRequest,
  DebitRequest,
  JsonObject,
  MoneyActor,
  StatementCursor,
  StatementEntry,
  StatementPage,
  TransferRequest,
  WalletOperationResult,
  WalletServiceContract,
  WalletTransaction,
  WalletTransactionContext,
  WalletTransactionWork,
} from "./types";
