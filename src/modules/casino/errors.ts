/**
 * Casino errors, separated from the service so the HTTP layer can catch them
 * without importing the wallet money path. See responsible/errors.ts.
 */
export class CasinoError extends Error {
  constructor(
    readonly code:
      | "INVALID_SESSION"
      | "INSUFFICIENT_FUNDS"
      | "ROUND_NOT_FOUND"
      | "ROUND_CLOSED"
      | "NOT_PERMITTED",
    message: string,
  ) {
    super(message);
    this.name = "CasinoError";
  }
}
