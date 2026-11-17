/**
 * Payment errors, separated from the services so the HTTP layer can catch
 * them without importing the wallet money path. See responsible/errors.ts.
 */

export class WithdrawalRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class KycLimitError extends WithdrawalRejectedError {
  constructor(
    readonly level: number,
    readonly capMinor: bigint,
    readonly requestedMinor: bigint,
  ) {
    super(
      level === 0
        ? "identity verification is required before withdrawing"
        : `withdrawal of ${requestedMinor} exceeds the level ${level} daily cap of ${capMinor}`,
    );
  }
}

export class AccountNotWithdrawableError extends WithdrawalRejectedError {
  constructor(readonly userId: string, readonly status: string) {
    super(`account ${userId} may not withdraw while ${status}`);
  }
}

export class UnattributableDepositError extends Error {
  constructor(readonly providerRef: string) {
    super(`deposit ${providerRef} could not be attributed to a user`);
    this.name = "UnattributableDepositError";
  }
}
