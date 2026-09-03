import { SportsbookBoardPage } from "@/components/sportsbook/board-page";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "PlutoBet — Football odds and live betting",
  description: "Bet on football with fast markets, clear prices and instant betslip.",
};

/**
 * The homepage IS the sportsbook.
 *
 * It used to open with a marketing hero and a grid of product tiles, most of
 * which linked to products that do not exist yet. A customer arriving to place
 * a bet had to scroll past all of it before seeing a single price. Now the
 * board is the page.
 */
export default function HomePage() {
  return <SportsbookBoardPage sport="football" />;
}
