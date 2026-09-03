"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createBrowserStore, useBrowserStore } from "./browser-store";

/**
 * Betslip state, and only betslip state.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It does not price a bet. Total odds and potential return shown here are a
 * PREVIEW so the customer can see what they are about to submit; the server
 * recomputes both from the stored selection prices and its answer is the one
 * that counts. Duplicating the pricing rules in the browser is how a display
 * and a payout drift apart, and on a betting site that difference is a
 * customer complaint with a screenshot attached.
 *
 * It also never writes money. Placement goes to the existing authenticated
 * route, which owns validation, idempotency and the ledger.
 *
 * Persistence is `sessionStorage`, not `localStorage`: a betslip is a piece of
 * in-progress intent, not a saved document, and finding yesterday's picks
 * still loaded is confusing rather than helpful.
 */

export interface Pick {
  selectionId: string;
  eventId: string;
  marketKey: string;
  selectionKey: string;
  selectionLabel: string;
  fixture: string;
  /** The price when it was added. Compared against the live price to warn. */
  odds: number;
  line?: number | null;
}

export type SlipStatus =
  | "idle"
  | "placing"
  | "placed"
  | "error";

interface BetslipValue {
  picks: Pick[];
  status: SlipStatus;
  message: string | null;
  placedBetId: string | null;
  stake: string;
  add: (pick: Pick) => void;
  remove: (selectionId: string) => void;
  toggle: (pick: Pick) => void;
  clear: () => void;
  setStake: (value: string) => void;
  has: (selectionId: string) => boolean;
  /** Live price moved since it was added, for the odds-changed warning. */
  noteLivePrice: (selectionId: string, price: number) => void;
  drift: Record<string, number>;
  setStatus: (status: SlipStatus, message?: string | null, betId?: string | null) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
}

const Ctx = createContext<BetslipValue | null>(null);

/**
 * What a restored slip is allowed to be.
 *
 * The blob comes from storage the customer can edit, so every field is
 * checked. A leg missing its selection id or carrying a non-numeric price is
 * dropped rather than handed to the odds tile — and a slip that survived a
 * restore is still only a request; the server prices it and decides.
 */
interface StoredSlip {
  picks: Pick[];
  stake: string;
}

const EMPTY_SLIP: StoredSlip = Object.freeze({ picks: [] as Pick[], stake: "" });

function isPick(value: unknown): value is Pick {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.selectionId === "string" &&
    typeof p.eventId === "string" &&
    typeof p.marketKey === "string" &&
    typeof p.selectionKey === "string" &&
    typeof p.selectionLabel === "string" &&
    typeof p.fixture === "string" &&
    typeof p.odds === "number" &&
    Number.isFinite(p.odds)
  );
}

const slipStore = createBrowserStore<StoredSlip>({
  area: "session",
  key: "plutobet.betslip.v1",
  fallback: EMPTY_SLIP,
  parse: (raw) => {
    if (typeof raw !== "object" || raw === null) return null;
    const value = raw as Record<string, unknown>;
    const picks = Array.isArray(value.picks) ? value.picks.filter(isPick) : [];
    const stake = typeof value.stake === "string" ? value.stake : "";
    return { picks, stake };
  },
});

export function BetslipProvider({ children }: { children: ReactNode }) {
  /*
   * THE STORE IS THE SLIP.
   *
   * Picks and stake live in session storage and are read through
   * `useSyncExternalStore`; there is no second copy in component state to keep
   * in step. The earlier version held both and copied one into the other on
   * mount, which meant an empty first render, a visible flash of an empty slip,
   * and two places that could disagree about what the customer had selected.
   *
   * Everything that is genuinely transient — placement status, the error
   * message, the odds-drift map, whether the mobile sheet is open — stays in
   * component state, because none of it should survive a reload.
   */
  const [slip, , updateSlip] = useBrowserStore(slipStore);
  const picks = slip.picks;
  const stake = slip.stake;

  const [status, setStatusRaw] = useState<SlipStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [placedBetId, setPlacedBetId] = useState<string | null>(null);
  const [drift, setDrift] = useState<Record<string, number>>({});
  const [open, setOpen] = useState(false);

  const setStake = useCallback(
    (value: string) => updateSlip((current) => ({ ...current, stake: value })),
    [updateSlip],
  );

  const add = useCallback(
    (pick: Pick) => {
      updateSlip((current) => {
        /*
         * One selection per MARKET per event. Two prices from the same market
         * cannot both win, so an accumulator containing both is guaranteed to
         * lose — some books allow it, and every one of those has a support
         * queue about it. Replacing is what the customer meant.
         */
        const without = current.picks.filter(
          (p) => !(p.eventId === pick.eventId && p.marketKey === pick.marketKey),
        );
        return { ...current, picks: [...without, pick] };
      });
      setStatusRaw("idle");
      setMessage(null);
    },
    [updateSlip],
  );

  const remove = useCallback(
    (selectionId: string) =>
      updateSlip((current) => ({
        ...current,
        picks: current.picks.filter((p) => p.selectionId !== selectionId),
      })),
    [updateSlip],
  );

  const has = useCallback(
    (selectionId: string) => picks.some((p) => p.selectionId === selectionId),
    [picks],
  );

  const toggle = useCallback(
    (pick: Pick) => {
      if (picks.some((p) => p.selectionId === pick.selectionId)) {
        remove(pick.selectionId);
        return;
      }
      add(pick);
    },
    [picks, add, remove],
  );

  const clear = useCallback(() => {
    updateSlip(() => ({ picks: [], stake: "" }));
    setDrift({});
    setStatusRaw("idle");
    setMessage(null);
    setPlacedBetId(null);
  }, [updateSlip]);

  const noteLivePrice = useCallback((selectionId: string, price: number) => {
    setDrift((current) => {
      if (current[selectionId] === price) return current;
      return { ...current, [selectionId]: price };
    });
  }, []);

  const setStatus = useCallback(
    (next: SlipStatus, text: string | null = null, betId: string | null = null) => {
      setStatusRaw(next);
      setMessage(text);
      if (betId) setPlacedBetId(betId);
    },
    [],
  );

  const value = useMemo<BetslipValue>(
    () => ({
      picks, status, message, placedBetId, stake, drift, open,
      add, remove, toggle, clear, setStake, has, noteLivePrice, setStatus, setOpen,
    }),
    [picks, status, message, placedBetId, stake, drift, open,
      add, remove, toggle, clear, setStake, has, noteLivePrice, setStatus],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBetslip(): BetslipValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useBetslip must be used inside <BetslipProvider>");
  return value;
}

/**
 * Preview arithmetic.
 *
 * Re-exported from `slip-math` rather than defined here, so the figures a
 * customer is shown before parting with money can be tested without rendering
 * a component. `potentialReturn` is GROSS — it includes the stake. `profit` is
 * what the customer actually gains. Showing the gross figure under the word
 * "profit" is a specific, common, and thoroughly misleading mistake, so the
 * two are separate values with separate names and both are displayed.
 */
export { slipMath, toKobo } from "./slip-math";
