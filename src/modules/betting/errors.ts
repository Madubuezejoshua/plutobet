/**
 * Typed placement failures. Callers branch on these, so they are classes, not
 * error strings — and every one of them means "nothing was written", because
 * placement is a single transaction that either commits whole or rolls back.
 */

export class BetRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class EmptySlipError extends BetRejectedError {
  constructor() {
    super("a bet slip needs at least one selection");
  }
}

export class DuplicateSelectionError extends BetRejectedError {
  constructor(readonly selectionId: string) {
    super(`selection ${selectionId} appears twice on the slip`);
  }
}

export class SelectionUnavailableError extends BetRejectedError {
  constructor(
    readonly selectionId: string,
    readonly reason: "MISSING" | "SELECTION_CLOSED" | "MARKET_CLOSED" | "EVENT_CLOSED",
  ) {
    super(`selection ${selectionId} is not available: ${reason}`);
  }
}

export class EventStartedError extends BetRejectedError {
  constructor(readonly eventId: string) {
    super(`event ${eventId} has already started`);
  }
}

/**
 * The price moved between the slip being shown and submitted. Carries both
 * prices so the UI can re-prompt with the new one.
 */
export class OddsDriftError extends BetRejectedError {
  constructor(
    readonly selectionId: string,
    readonly submittedOdds: string,
    readonly currentOdds: string,
  ) {
    super(
      `odds for ${selectionId} moved from ${submittedOdds} to ${currentOdds} before placement`,
    );
  }
}

export class StakeLimitError extends BetRejectedError {
  constructor(readonly stakeMinor: bigint, readonly minMinor: bigint, readonly maxMinor: bigint) {
    super(`stake ${stakeMinor} is outside the permitted range ${minMinor}–${maxMinor}`);
  }
}

export class ExposureLimitError extends BetRejectedError {
  constructor(readonly marketId: string, readonly liabilityMinor: bigint) {
    super(`market ${marketId} cannot absorb a further liability of ${liabilityMinor}`);
  }
}

/**
 * The per-user half of invariant 11.
 *
 * Distinct from ExposureLimitError because the two mean different things to
 * whoever reads the log: a market ceiling says the BOOK is full on an event,
 * while this says one ACCOUNT is carrying too much open risk. Collapsing them
 * would hide the account-level signal that matters to risk.
 */
export class UserExposureLimitError extends BetRejectedError {
  constructor(
    readonly userId: string,
    readonly wouldBeMinor: bigint,
    readonly capMinor: bigint,
  ) {
    super(
      `this bet would take your open liability to ${wouldBeMinor}, above the ${capMinor} account limit`,
    );
  }
}

/** Self-exclusion and suspension both land here — see §7. */
export class AccountNotEligibleError extends BetRejectedError {
  constructor(readonly userId: string, readonly status: string) {
    super(`account ${userId} may not place bets while ${status}`);
  }
}
