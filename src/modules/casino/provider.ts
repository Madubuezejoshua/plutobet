/**
 * Casino aggregator contract.
 *
 * Same rule as the odds and payment adapters: nothing outside this module
 * imports a vendor type, so swapping Spribe for Pragmatic is a new adapter
 * rather than a rewrite of the lobby.
 *
 * WHAT AN AGGREGATOR IS RESPONSIBLE FOR, AND WE ARE NOT
 * Outcomes. Every spin, card and crash multiplier is generated and certified
 * on their side. We authenticate their callbacks, move money through the
 * wallet like any other money path, and keep the evidence. Self-built RNG does
 * not pass GLI-33, and a platform that generates its own casino results cannot
 * prove it did so fairly.
 */

export interface CasinoGameSummary {
  providerGameId: string;
  name: string;
  category: "SLOTS" | "TABLE" | "LIVE_CASINO" | "CRASH" | "INSTANT" | "JACKPOT";
  thumbnailUrl?: string;
  /** Basis points: 9600 = 96.00%. Omitted when the provider does not publish it. */
  rtpBasisPoints?: number;
}

export interface LaunchParams {
  /** Our short-lived session token; the aggregator echoes it on callbacks. */
  token: string;
  providerGameId: string;
  userId: string;
  currency: "NGN";
  language: string;
  /** Where the game returns the player when they close it. */
  returnUrl: string;
  demo: boolean;
}

export interface CasinoProvider {
  readonly key: string;
  readonly name: string;

  /** The catalogue, for syncing into casino_games. */
  listGames(): Promise<CasinoGameSummary[]>;

  /**
   * The URL to open the game at.
   *
   * Returns a URL rather than embedding a client: the aggregator owns the game
   * frame, and anything we render around it must not be able to observe or
   * influence what happens inside.
   */
  launchUrl(params: LaunchParams): Promise<string>;

  /**
   * Verifies a callback signature.
   *
   * THROWS on a bad signature rather than returning false. An unverified
   * casino callback is somebody crediting themselves a win, and a boolean
   * return invites a caller that forgets to check it.
   */
  verifyCallback(rawBody: string, signature: string | null): void;
}

export class CasinoSignatureError extends Error {
  constructor() {
    // No detail: this message can reach logs an attacker may probe.
    super("casino callback signature verification failed");
    this.name = "CasinoSignatureError";
  }
}
