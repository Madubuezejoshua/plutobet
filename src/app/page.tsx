import { redirect } from "next/navigation";

/**
 * The front door of a sportsbook is the odds board.
 *
 * This used to be a marketing page about ledger architecture — interesting to
 * an auditor, useless to someone arriving to place a bet. Anyone landing here
 * wants fixtures and prices, so send them straight there.
 */
export default function HomePage() {
  redirect("/sports");
}
