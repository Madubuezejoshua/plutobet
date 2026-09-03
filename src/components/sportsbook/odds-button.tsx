"use client";

import { useEffect } from "react";
import { useBetslip, type Pick } from "./betslip-store";

/**
 * One price.
 *
 * Every state a price can be in is represented here, because a sportsbook that
 * renders an unavailable price the same as an available one will take a bet it
 * cannot honour.
 *
 * ODDS ARE NEVER INVENTED. `price` is what the server stored; when there is no
 * price the caller passes `state="unavailable"` and the tile renders a dash. A
 * plausible-looking number in place of a missing one is a fabricated price, and
 * on a betting site that is indistinguishable from fraud.
 */

export type OddsState =
  | "open"
  | "suspended"
  | "closed"
  | "unavailable";

export interface OddsButtonProps {
  /** Column label, e.g. "1", "X", "2", "Over 2.5". Always rendered. */
  label: string;
  price: number | null;
  state?: OddsState;
  /** Everything needed to put this price on the slip. Omit for a dead column. */
  pick?: Omit<Pick, "odds">;
  /** Movement since the customer last saw it, if known. */
  movement?: "up" | "down" | null;
  className?: string;
}

const STATE_TEXT: Record<Exclude<OddsState, "open">, string> = {
  suspended: "Suspended",
  closed: "Closed",
  unavailable: "Not available",
};

export function OddsButton({
  label,
  price,
  state = "open",
  pick,
  movement = null,
  className,
}: OddsButtonProps) {
  const slip = useBetslip();

  const usable = state === "open" && price !== null && price > 1 && Boolean(pick);
  const selected = pick ? slip.has(pick.selectionId) : false;

  /*
   * Tell the slip what this price is NOW, so a selection added at 2.10 and
   * since moved to 1.95 can warn before the customer submits it. Reported from
   * the board rather than polled by the slip, because the board is the thing
   * that actually has the current number.
   */
  useEffect(() => {
    if (pick && price !== null && selected) slip.noteLivePrice(pick.selectionId, price);
  }, [pick, price, selected, slip]);

  const shown = price !== null && price > 0 ? price.toFixed(2) : "—";

  /*
   * The accessible name carries the label, the price and the state. A screen
   * reader user hearing only "2.10" has no idea which team that is for.
   */
  const stateText = state === "open" ? "" : `, ${STATE_TEXT[state]}`;
  const ariaLabel =
    price === null || state !== "open"
      ? `${label}${stateText || ", not available"}`
      : `${label}, odds ${shown}${selected ? ", selected" : ""}`;

  return (
    <button
      type="button"
      className={`sb-odd${movement ? ` sb-odd--${movement}` : ""}${className ? ` ${className}` : ""}`}
      data-state={state}
      aria-pressed={usable ? selected : undefined}
      aria-label={ariaLabel}
      disabled={!usable}
      onClick={() => {
        if (!usable || !pick || price === null) return;
        slip.toggle({ ...pick, odds: price });
      }}
    >
      <span className="sb-odd__label" aria-hidden="true">{label}</span>
      <span className="sb-odd__value" aria-hidden="true">{shown}</span>
    </button>
  );
}
