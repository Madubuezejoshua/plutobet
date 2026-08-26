export class WalletError extends Error {}

export class InvalidAmountError extends WalletError {
  constructor(public readonly amountMinor: unknown) {
    super(`amountMinor must be a positive signed-64-bit bigint; received ${String(amountMinor)}`);
    this.name = "InvalidAmountError";
  }
}

export class InvalidWalletIdError extends WalletError {
  constructor(public readonly walletId: string) {
    super(`invalid wallet UUID: ${walletId}`);
    this.name = "InvalidWalletIdError";
  }
}

export class WalletNotFoundError extends WalletError {
  constructor(public readonly walletId: string) {
    super(`wallet not found: ${walletId}`);
    this.name = "WalletNotFoundError";
  }
}

export class NonUserWalletError extends WalletError {
  constructor(public readonly walletId: string) {
    super(`wallet operation requires a user wallet: ${walletId}`);
    this.name = "NonUserWalletError";
  }
}

export class WalletOwnershipError extends WalletError {
  constructor(
    public readonly actorUserId: string,
    public readonly walletId: string,
  ) {
    super(`user ${actorUserId} does not own wallet ${walletId}`);
    this.name = "WalletOwnershipError";
  }
}

export class InsufficientFundsError extends WalletError {
  constructor(
    public readonly walletId: string,
    public readonly requestedMinor: bigint,
    public readonly availableMinor: bigint,
  ) {
    super(
      `insufficient funds on wallet ${walletId}: requested ${requestedMinor}, available ${availableMinor}`,
    );
    this.name = "InsufficientFundsError";
  }
}

export class IdempotencyConflictError extends WalletError {
  constructor(public readonly idempotencyKey: string) {
    super(`idempotency key was already used for a different operation: ${idempotencyKey}`);
    this.name = "IdempotencyConflictError";
  }
}

export class ReferenceConflictError extends WalletError {
  constructor(public readonly reference: string) {
    super(`ledger reference was already used by a different operation: ${reference}`);
    this.name = "ReferenceConflictError";
  }
}

export class InvalidIdempotencyKeyError extends WalletError {
  constructor() {
    super("idempotencyKey must contain between 1 and 200 characters");
    this.name = "InvalidIdempotencyKeyError";
  }
}

export class InvalidMetadataError extends WalletError {
  constructor(message: string) {
    super(`metadata must be JSON-safe: ${message}`);
    this.name = "InvalidMetadataError";
  }
}

export class InvalidActorError extends WalletError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidActorError";
  }
}

export class AdminAuthorizationError extends WalletError {
  constructor(message: string) {
    super(message);
    this.name = "AdminAuthorizationError";
  }
}

export class SelfTransferError extends WalletError {
  constructor() {
    super("cannot transfer a wallet to itself");
    this.name = "SelfTransferError";
  }
}

export class ConcurrentWalletMutationError extends WalletError {
  constructor(public readonly walletId: string) {
    super(`wallet ${walletId} changed during reconciliation; retry the durable step`);
    this.name = "ConcurrentWalletMutationError";
  }
}
