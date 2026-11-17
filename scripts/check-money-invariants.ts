/**
 * The money gate.
 *
 *   npx tsx scripts/check-money-invariants.ts
 *
 * Asks the database the nine questions whose answer must be zero, and exits
 * non-zero if any of them is not. Read-only: every statement behind it is a
 * SELECT, because a checker that repairs what it finds can no longer tell you
 * the system was ever broken.
 *
 * REFUSES TO RUN AGAINST ANYTHING BUT A LOCAL DATABASE. It is read-only, so the
 * risk is not damage — it is that somebody runs it against production, sees
 * green, and reports it as evidence about a system this pass never touched.
 * A gate whose provenance is ambiguous is worse than no gate.
 */
import "dotenv/config";
import { moneyInvariants, MUST_BE_ZERO, type MoneyInvariants } from "@/modules/qa/invariants";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function assertLocalDatabase(): void {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Refusing to report on an unknown database.");
    process.exit(1);
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    console.error("DATABASE_URL is not a URL. Refusing to start.");
    process.exit(1);
  }
  if (!LOOPBACK.has(host)) {
    // The host is named because that is the entire point of the message, and a
    // hostname is not a credential. Nothing else from the URL is printed.
    console.error(
      `DATABASE_URL points at "${host}", which is not this machine.\n` +
        "These invariants are reported as evidence about the disposable review\n" +
        "database. Refusing to run.",
    );
    process.exit(1);
  }
}

const LABELS: Record<keyof MoneyInvariants, string> = {
  unbalancedTransactions: "ledger transactions whose debits and credits disagree",
  negativeWallets: "wallets holding less than nothing",
  duplicatePayouts: "bets settled and paid more than once",
  cacheDrift: "wallets whose cached balance disagrees with their entries",
  pendingOnFinalEvents: "bets still PENDING on a match that has a final result",
  wonWithoutPayout: "bets marked WON with no payout against them",
  openMarketsOnFinalEvents: "markets still OPEN on a match that has a final result",
  residualExposureMarkets: "markets still holding liability with no pending bet",
  failedOutboxItems: "settlement work items abandoned after exhausting their attempts",
};

async function main(): Promise<void> {
  assertLocalDatabase();
  const invariants = await moneyInvariants();

  const width = Math.max(...Object.values(LABELS).map((l) => l.length));
  for (const key of MUST_BE_ZERO) {
    const value = invariants[key];
    console.log(`  ${LABELS[key].padEnd(width)}  ${value === 0 ? "0" : `${value}  <-- FAIL`}`);
  }

  const violations = MUST_BE_ZERO.filter((key) => invariants[key] !== 0);
  if (violations.length > 0) {
    console.error(
      `\nmoney invariants: ${violations.length} of ${MUST_BE_ZERO.length} are not zero.\n` +
        "Nothing has been repaired. Find the cause before running anything else.",
    );
    process.exit(1);
  }
  console.log(`\nmoney invariants: all ${MUST_BE_ZERO.length} are zero.`);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error("money invariants failed to run:", error instanceof Error ? error.message : error);
  process.exit(1);
});
