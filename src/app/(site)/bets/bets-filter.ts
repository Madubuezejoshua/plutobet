export interface SerializedBetLeg {
  fixture: string;
  selection: string;
  odds: string;
  result: string;
}

export interface SerializedBetRow {
  id: string;
  status: string;
  stake_minor: string;
  total_odds_decimal: string;
  potential_return_minor: string;
  cashout_value_minor: string | null;
  cashed_out_stake_minor: string;
  placed_at: string;
  settled_at: string | null;
  legs: SerializedBetLeg[];
}

export type OutcomeFilter = "ALL" | "PENDING" | "WON" | "LOST" | "VOID" | "CASHED_OUT";

export const OUTCOME_OPTIONS: { value: OutcomeFilter; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "PENDING", label: "Open" },
  { value: "WON", label: "Won" },
  { value: "LOST", label: "Lost" },
  { value: "VOID", label: "Void" },
  { value: "CASHED_OUT", label: "Cashed out" },
];

export function betStatusLabel(status: string): string {
  switch (status) {
    case "PENDING":
      return "Open";
    case "CASHED_OUT":
      return "Cashed out";
    case "VOID":
      return "Void";
    default:
      return status.charAt(0) + status.slice(1).toLowerCase();
  }
}

/** Colour is a second signal only; the pill always carries its own word. */
export function betPillClass(status: string): string {
  if (status === "WON") return "sb-pill--won";
  if (status === "LOST") return "sb-pill--lost";
  if (status === "PENDING") return "sb-pill--open";
  if (status === "VOID") return "sb-pill--void";
  return "";
}

export function filterBets(
  bets: SerializedBetRow[],
  query: string,
  outcomeFilter: OutcomeFilter,
): SerializedBetRow[] {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  return bets.filter((bet) => {
    if (outcomeFilter !== "ALL" && bet.status !== outcomeFilter) {
      return false;
    }

    if (tokens.length === 0) return true;

    const parts = [
      bet.id.slice(0, 8),
      bet.status,
      betStatusLabel(bet.status),
      ...bet.legs.flatMap((leg) => [
        leg.fixture,
        leg.selection,
        leg.result,
        leg.result ? betStatusLabel(leg.result) : "",
      ]),
    ];
    const haystack = parts.join(" ").toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}
