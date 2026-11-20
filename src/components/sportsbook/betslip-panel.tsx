"use client";

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Bookmark,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Loader2,
  Share2,
  Shield,
  Ticket,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";
import { naira } from "@/lib/money";
import { namedSystems } from "@/modules/betting/system-bet";
import { useBetslip, type Pick } from "./betslip-store";
import { slipMath, systemSlipMath, toKobo } from "./slip-math";

/**
 * The betslip: Singles, Accumulators, Cut-1 / Flexi System bets, and Booking Codes.
 *
 * MONEY RULES OBSERVED HERE
 * -------------------------
 * 1. "Potential return" is GROSS and includes the stake. "Profit" is shown as
 *    its own, smaller figure.
 * 2. For Cut-1 / System bets, total stake (`unitStake × combinations`) is
 *    always displayed explicitly before confirmation so nobody confuses a
 *    unit stake with the full cost.
 * 3. Booking codes save and load SELECTIONS at live prices via `/api/bookings`
 *    — never a stake or an already-placed bet.
 * 4. Placement goes to `/api/bets` with an idempotency key. Nothing here
 *    writes a balance, and success is only shown for a real bet id.
 */

const QUICK_STAKES = [100, 500, 1000, 5000];

type BetMode = "acca" | "cut1" | "system";

interface CustomerFailure {
  code: string;
  message: string;
}

interface BookedSelectionPayload {
  selectionId: string;
  eventId: string;
  fixture: string;
  marketKey: string;
  selectionLabel: string;
  currentPrice: number | null;
  available: boolean;
}

interface PlacedSummary {
  betId: string;
  placedCount: number;
  combinationCount: number;
  totalStakeMinor: string | null;
}

function customerFailures(body: unknown): CustomerFailure[] {
  if (!body || typeof body !== "object" || !("details" in body)) return [];
  const details = (body as { details: unknown }).details;
  if (!Array.isArray(details)) return [];
  return details.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.code !== "string" || typeof row.message !== "string") return [];
    return [{ code: row.code, message: row.message }];
  });
}

function safeIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function BetslipPanel({
  signedIn,
  balanceMinor,
  compact = false,
  onClose,
}: {
  signedIn: boolean;
  balanceMinor?: string | null;
  compact?: boolean;
  onClose?: () => void;
}) {
  const slip = useBetslip();
  const [tab, setTab] = useState<"slip" | "mine">("slip");
  const [confirming, setConfirming] = useState(false);
  const [betMode, setBetMode] = useState<BetMode>("acca");
  const [customSystemSize, setCustomSystemSize] = useState<number>(2);
  const [bankerIds, setBankerIds] = useState<string[]>([]);
  const [placedSummary, setPlacedSummary] = useState<PlacedSummary | null>(null);

  // Booking code state
  const [codeInput, setCodeInput] = useState("");
  const [codeLoading, setCodeLoading] = useState(false);
  const [codeFeedback, setCodeFeedback] = useState<{ kind: "ok" | "warn" | "error"; text: string } | null>(null);
  const [showLoaderBar, setShowLoaderBar] = useState(false);
  const [bookingBusy, setBookingBusy] = useState(false);
  const [bookedCode, setBookedCode] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

  const panelId = useId();
  const stakeId = `${panelId}-stake`;
  const stakeErrorId = `${panelId}-stake-error`;
  const bookingInputId = `${panelId}-booking-code`;

  const pickCount = slip.picks.length;
  const systemOptions = useMemo(
    () => namedSystems(pickCount).filter((opt) => opt.systemSize < pickCount),
    [pickCount],
  );

  // Effective mode gracefully falls back to acca if fewer than 3 selections remain.
  const effectiveMode: BetMode =
    pickCount >= 3 && systemOptions.length > 0 ? betMode : "acca";

  const activeSystemSize = useMemo(() => {
    if (effectiveMode === "cut1") return Math.max(2, pickCount - 1);
    if (effectiveMode === "system") {
      const validSizes = systemOptions.map((o) => o.systemSize);
      if (validSizes.includes(customSystemSize)) return customSystemSize;
      return validSizes[0] ?? Math.max(2, pickCount - 1);
    }
    return pickCount;
  }, [effectiveMode, pickCount, systemOptions, customSystemSize]);

  // Map banker selectionIds to current indices cleanly.
  const bankerIndices = useMemo(() => {
    if (effectiveMode !== "system") return [];
    const indices: number[] = [];
    slip.picks.forEach((p, idx) => {
      if (bankerIds.includes(p.selectionId)) indices.push(idx);
    });
    return indices;
  }, [effectiveMode, slip.picks, bankerIds]);

  const isSystemSlip = effectiveMode !== "acca" && pickCount >= 3;
  const unitStakeMinor = toKobo(slip.stake);

  const accaPreview = useMemo(
    () => slipMath(slip.picks, unitStakeMinor ?? 0n),
    [slip.picks, unitStakeMinor],
  );

  const systemPreview = useMemo(
    () =>
      isSystemSlip
        ? systemSlipMath(slip.picks, unitStakeMinor ?? 0n, activeSystemSize, bankerIndices)
        : null,
    [isSystemSlip, slip.picks, unitStakeMinor, activeSystemSize, bankerIndices],
  );

  const totalCostMinor = isSystemSlip
    ? (systemPreview?.totalStakeMinor ?? 0n)
    : (unitStakeMinor ?? 0n);

  const balance = balanceMinor ? BigInt(balanceMinor) : null;
  const insufficient = balance !== null && totalCostMinor > 0n && totalCostMinor > balance;

  const moved = slip.picks
    .map((p) => ({ pick: p, now: slip.drift[p.selectionId] }))
    .filter((x) => typeof x.now === "number" && x.now !== x.pick.odds);

  const stakeInvalid = slip.stake.trim() !== "" && unitStakeMinor === null;
  const systemInvalid = isSystemSlip && Boolean(systemPreview && !systemPreview.valid);
  const canPlace =
    signedIn &&
    pickCount > 0 &&
    unitStakeMinor !== null &&
    unitStakeMinor > 0n &&
    !insufficient &&
    !systemInvalid &&
    slip.status !== "placing";

  function toggleBanker(selectionId: string) {
    setBookedCode(null);
    setBankerIds((prev) =>
      prev.includes(selectionId)
        ? prev.filter((id) => id !== selectionId)
        : [...prev, selectionId],
    );
  }

  async function loadBookingCode(event: React.FormEvent) {
    event.preventDefault();
    const cleaned = codeInput.trim().toUpperCase();
    if (!cleaned) return;
    setCodeLoading(true);
    setCodeFeedback(null);
    setBookedCode(null);

    try {
      const response = await fetch(`/api/bookings?code=${encodeURIComponent(cleaned)}`);
      const body = (await response.json().catch(() => null)) as
        | {
            code?: string;
            hasUnavailable?: boolean;
            selections?: BookedSelectionPayload[];
            message?: string;
          }
        | null;

      if (!response.ok || !body?.selections) {
        setCodeFeedback({
          kind: "error",
          text: body?.message ?? "We could not find an active slip for that booking code.",
        });
        return;
      }

      const available = body.selections.filter(
        (sel) => sel.available && typeof sel.currentPrice === "number" && sel.currentPrice > 1,
      );

      if (available.length === 0) {
        setCodeFeedback({
          kind: "warn",
          text: "All matches on that booking code have already started or closed.",
        });
        return;
      }

      const nextPicks: Pick[] = available.map((sel) => ({
        selectionId: sel.selectionId,
        eventId: sel.eventId,
        marketKey: sel.marketKey,
        selectionKey: sel.selectionLabel.toLowerCase(),
        selectionLabel: sel.selectionLabel,
        fixture: sel.fixture,
        odds: sel.currentPrice!,
      }));

      slip.replacePicks(nextPicks);
      setBankerIds([]);
      setBetMode("acca");
      setCodeInput("");
      setShowLoaderBar(false);

      const skipped = body.selections.length - available.length;
      setCodeFeedback(
        skipped > 0
          ? {
              kind: "warn",
              text: `Loaded ${available.length} selection${available.length === 1 ? "" : "s"} from ${body.code ?? cleaned}. ${skipped} expired or closed leg${skipped === 1 ? " was" : "s were"} skipped.`,
            }
          : {
              kind: "ok",
              text: `Loaded ${available.length} selection${available.length === 1 ? "" : "s"} from code ${body.code ?? cleaned} at live odds.`,
            },
      );
    } catch {
      setCodeFeedback({
        kind: "error",
        text: "Network error loading booking code. Please try again.",
      });
    } finally {
      setCodeLoading(false);
    }
  }

  async function createBookingCode() {
    if (pickCount === 0 || bookingBusy) return;
    setBookingBusy(true);
    setCodeFeedback(null);
    setCopiedCode(false);

    try {
      const response = await fetch("/api/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          selectionIds: slip.picks.map((p) => p.selectionId),
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | { code?: string; message?: string }
        | null;

      if (!response.ok || !body?.code) {
        setCodeFeedback({
          kind: "error",
          text: body?.message ?? "Could not create a booking code for these selections.",
        });
        return;
      }
      setBookedCode(body.code);
    } catch {
      setCodeFeedback({
        kind: "error",
        text: "Network error while booking slip. Please try again.",
      });
    } finally {
      setBookingBusy(false);
    }
  }

  async function copyBookingCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 2000);
    } catch {
      setCodeFeedback({ kind: "ok", text: `Booking code: ${code}` });
    }
  }

  async function shareBookingCode(code: string) {
    const shareText = `Load my PlutoBet slip (${pickCount} ${pickCount === 1 ? "pick" : "picks"}) with booking code: ${code}`;
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "PlutoBet Booking Code", text: shareText });
        return;
      } catch {
        // User cancelled or share unsupported; fall back to copy
      }
    }
    await copyBookingCode(code);
  }

  async function place() {
    if (!canPlace || unitStakeMinor === null) return;
    slip.setStatus("placing");
    setPlacedSummary(null);
    try {
      const payload: Record<string, unknown> = {
        stakeMinor: unitStakeMinor.toString(),
        idempotencyKey: safeIdempotencyKey(),
        legs: slip.picks.map((p) => ({
          selectionId: p.selectionId,
          odds: p.odds.toFixed(3),
        })),
      };
      if (isSystemSlip) {
        payload.systemSize = activeSystemSize;
        if (bankerIndices.length > 0) {
          payload.bankerIndices = bankerIndices;
        }
      }

      const response = await fetch("/api/bets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const failures = customerFailures(body);
        const reasons = [...new Set(failures.map((f) => f.message))];
        const summary =
          body && typeof body === "object" && "message" in body
            ? String((body as { message: unknown }).message)
            : "That bet could not be placed. Nothing has been charged.";

        if (failures.some((f) => f.code === "ODDS_CHANGED") && slip.adoptDrift() > 0) {
          slip.setStatus(
            "error",
            `${reasons[0] ?? summary} The new price is on your slip — check the return and place again.`,
          );
          return;
        }

        slip.setStatus(
          "error",
          reasons.length === 1
            ? reasons[0]!
            : reasons.length > 1
              ? `${summary}: ${reasons.join(" ")}`
              : summary,
        );
        return;
      }

      const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
      const betId = rec && typeof rec.betId === "string" ? rec.betId : null;

      if (!betId) {
        slip.setStatus("error", "The bet may not have been placed. Check My Bets before retrying.");
        return;
      }

      setPlacedSummary({
        betId,
        placedCount: typeof rec?.placedCount === "number" ? rec.placedCount : 1,
        combinationCount: typeof rec?.combinationCount === "number" ? rec.combinationCount : 1,
        totalStakeMinor: typeof rec?.totalStakeMinor === "string" ? rec.totalStakeMinor : null,
      });
      setBookedCode(null);
      slip.setStatus("placed", null, betId);
    } catch {
      slip.setStatus(
        "error",
        "We could not reach the server. Check My Bets before trying again — nothing is charged twice.",
      );
    } finally {
      setConfirming(false);
    }
  }

  const bookingForm = (
    <form onSubmit={loadBookingCode} className="sb-booking-form" aria-label="Load booking code">
      <label className="sb-sr" htmlFor={bookingInputId}>
        Booking code
      </label>
      <input
        id={bookingInputId}
        type="text"
        value={codeInput}
        onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
        placeholder="Enter booking code"
        autoComplete="off"
        maxLength={24}
        className="sb-booking-input"
      />
      <button
        type="submit"
        className="sb-btn sb-btn--dark sb-booking-submit"
        disabled={codeLoading || codeInput.trim().length < 3}
      >
        {codeLoading ? (
          <Loader2 size={14} className="sb-spin" aria-hidden="true" />
        ) : (
          <Download size={14} aria-hidden="true" />
        )}
        <span>Load</span>
      </button>
    </form>
  );

  return (
    <section className="sb-panel sb-slip" aria-label="Betslip">
      <div className="sb-slip__tabs" role="tablist" aria-label="Betslip sections">
        <button
          type="button"
          role="tab"
          className="sb-slip__tab"
          aria-selected={tab === "slip"}
          onClick={() => setTab("slip")}
        >
          Betslip{pickCount > 0 ? ` (${pickCount})` : ""}
        </button>
        <button
          type="button"
          role="tab"
          className="sb-slip__tab"
          aria-selected={tab === "mine"}
          onClick={() => setTab("mine")}
        >
          My Bets
        </button>
        {onClose ? (
          <button
            type="button"
            className="sb-slip__close"
            onClick={onClose}
            aria-label="Close betslip"
          >
            <X size={18} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {tab === "mine" ? (
        <div className="sb-pad sb-stack">
          <p className="sb-small sb-muted">
            Your open and settled bets, live cash-out offers, and 1-tap re-bet.
          </p>
          <Link href="/bets" className="sb-btn sb-btn--ghost" style={{ width: "100%" }}>
            Open My Bets
          </Link>
        </div>
      ) : (
        <>
          {/* ------------------------------------------------ placed */}
          {slip.status === "placed" && slip.placedBetId ? (
            <div className="sb-pad sb-stack">
              <div className="sb-note sb-note--ok" role="status">
                <CheckCircle2 size={15} aria-hidden="true" />
                <span>
                  {placedSummary && placedSummary.placedCount > 1
                    ? `${placedSummary.placedCount} of ${placedSummary.combinationCount} system bets placed${
                        placedSummary.totalStakeMinor
                          ? ` (${naira(placedSummary.totalStakeMinor)})`
                          : ""
                      }.`
                    : `Bet placed. Reference ${slip.placedBetId.slice(0, 8)}.`}
                </span>
              </div>
              <Link href="/bets" className="sb-btn sb-btn--ghost" style={{ width: "100%" }}>
                View in My Bets
              </Link>
              <button
                type="button"
                className="sb-btn sb-btn--primary"
                style={{ width: "100%" }}
                onClick={() => {
                  setPlacedSummary(null);
                  setBankerIds([]);
                  setBetMode("acca");
                  slip.clear();
                }}
              >
                New betslip
              </button>
            </div>
          ) : pickCount === 0 ? (
            /* ------------------------------------------------- empty */
            <div className="sb-pad sb-stack">
              <div className="sb-empty" style={{ padding: "18px 8px 10px" }}>
                <Ticket className="sb-empty__icon" size={26} aria-hidden="true" />
                <p className="sb-empty__title">Your betslip is empty</p>
                <p className="sb-small">Tap any odds to add a selection, or load a booking code below.</p>
              </div>

              <div className="sb-booking-box">
                <p className="sb-booking-box__title">
                  <Bookmark size={13} aria-hidden="true" /> Have a Booking Code?
                </p>
                {bookingForm}
              </div>

              {codeFeedback ? (
                <p
                  className={`sb-note ${
                    codeFeedback.kind === "error"
                      ? "sb-note--error"
                      : codeFeedback.kind === "warn"
                        ? "sb-note--warn"
                        : "sb-note--ok"
                  }`}
                  role="status"
                >
                  {codeFeedback.text}
                </p>
              ) : null}
            </div>
          ) : (
            <>
              {/* ------------------------ bet mode bar (Acca / Cut 1 / System) */}
              {pickCount >= 3 && systemOptions.length > 0 ? (
                <div className="sb-slip-modes" role="tablist" aria-label="Bet type">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={effectiveMode === "acca"}
                    className="sb-slip-mode"
                    onClick={() => {
                      setBetMode("acca");
                      setConfirming(false);
                    }}
                  >
                    Acca ({pickCount})
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={effectiveMode === "cut1"}
                    className="sb-slip-mode"
                    onClick={() => {
                      setBetMode("cut1");
                      setConfirming(false);
                    }}
                  >
                    <Shield size={12} aria-hidden="true" />
                    Cut 1 ({pickCount - 1}/{pickCount})
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={effectiveMode === "system"}
                    className="sb-slip-mode"
                    onClick={() => {
                      setBetMode("system");
                      setConfirming(false);
                    }}
                  >
                    System
                  </button>
                </div>
              ) : null}

              {effectiveMode === "system" && systemOptions.length > 0 ? (
                <div className="sb-system-bar">
                  <div className="sb-system-bar__chips" role="group" aria-label="System combinations">
                    {systemOptions.map((opt) => (
                      <button
                        key={opt.systemSize}
                        type="button"
                        className="sb-system-pill"
                        aria-pressed={activeSystemSize === opt.systemSize}
                        onClick={() => setCustomSystemSize(opt.systemSize)}
                      >
                        {opt.systemSize}/{pickCount}
                      </button>
                    ))}
                  </div>
                  <p className="sb-xs sb-muted" style={{ margin: 0 }}>
                    Tap <strong>B</strong> on a leg to lock it as a banker in every combo.
                  </p>
                </div>
              ) : effectiveMode === "cut1" ? (
                <div className="sb-system-bar">
                  <p className="sb-xs sb-muted" style={{ margin: 0 }}>
                    <strong>Cut 1 protection:</strong> backs all{" "}
                    <strong>{systemPreview?.combinations ?? pickCount}</strong> combinations of{" "}
                    {activeSystemSize}/{pickCount} — you still win a payout even if 1 game cuts!
                  </p>
                </div>
              ) : null}

              {/* ---------------------------------------- selections */}
              <div>
                {slip.picks.map((pick) => {
                  const now = slip.drift[pick.selectionId];
                  const changed = typeof now === "number" && now !== pick.odds;
                  const isBanker = effectiveMode === "system" && bankerIds.includes(pick.selectionId);
                  return (
                    <div className="sb-pick" key={pick.selectionId}>
                      <div className="sb-pick__top">
                        <div style={{ minWidth: 0 }}>
                          <div className="sb-pick__sel">{pick.selectionLabel}</div>
                          <div className="sb-pick__market">{pick.marketKey.replace(/_/g, " ")}</div>
                          <div className="sb-pick__fixture">{pick.fixture}</div>
                        </div>
                        {effectiveMode === "system" ? (
                          <button
                            type="button"
                            className="sb-banker-btn"
                            aria-pressed={isBanker}
                            title={isBanker ? "Remove banker" : "Mark as banker"}
                            aria-label={`Mark ${pick.selectionLabel} as banker`}
                            onClick={() => toggleBanker(pick.selectionId)}
                          >
                            B
                          </button>
                        ) : null}
                        <span className="sb-pick__odds">{pick.odds.toFixed(2)}</span>
                        <button
                          type="button"
                          className="sb-pick__x"
                          aria-label={`Remove ${pick.selectionLabel} from betslip`}
                          onClick={() => {
                            setBookedCode(null);
                            setBankerIds((prev) => prev.filter((id) => id !== pick.selectionId));
                            slip.remove(pick.selectionId);
                          }}
                        >
                          <X size={14} aria-hidden="true" />
                        </button>
                      </div>
                      {changed ? (
                        <div className="sb-note sb-note--warn" style={{ padding: "6px 0 0" }} role="status">
                          {now > pick.odds ? (
                            <TrendingUp size={14} aria-hidden="true" />
                          ) : (
                            <TrendingDown size={14} aria-hidden="true" />
                          )}
                          <span>
                            Odds moved to <strong>{now.toFixed(2)}</strong>. Your{" "}
                            <Link href="/account/preferences">odds-change setting</Link> decides
                            whether that is accepted for you or offered back to confirm.
                          </span>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              {/* --------------------------------------------- stake */}
              <div className="sb-pad sb-stack">
                {!isSystemSlip && pickCount > 1 ? (
                  <p className="sb-xs sb-muted" style={{ margin: 0 }}>
                    Accumulator · {pickCount} selections · all must win
                  </p>
                ) : null}

                {isSystemSlip && systemPreview?.valid ? (
                  <p className="sb-xs sb-muted" style={{ margin: 0 }}>
                    Stake per combination ({systemPreview.combinations}{" "}
                    {systemPreview.combinations === 1 ? "bet" : "bets"})
                  </p>
                ) : null}

                <label className="sb-sr" htmlFor={stakeId}>
                  {isSystemSlip ? "Stake per combination in naira" : "Stake in naira"}
                </label>
                <input
                  id={stakeId}
                  className="sb-stake"
                  inputMode="decimal"
                  placeholder={isSystemSlip ? "Stake per bet (₦)" : "Stake (₦)"}
                  value={slip.stake}
                  aria-invalid={stakeInvalid || insufficient || systemInvalid}
                  aria-describedby={stakeInvalid || insufficient ? stakeErrorId : undefined}
                  onChange={(e) => slip.setStake(e.target.value)}
                />

                <div className="sb-quick">
                  {QUICK_STAKES.map((amount) => (
                    <button key={amount} type="button" onClick={() => slip.setStake(String(amount))}>
                      ₦{amount.toLocaleString("en-NG")}
                    </button>
                  ))}
                </div>

                {systemInvalid && systemPreview?.error ? (
                  <p className="sb-note sb-note--error" role="alert">
                    <AlertTriangle size={14} aria-hidden="true" />
                    {systemPreview.error}
                  </p>
                ) : null}

                {stakeInvalid ? (
                  <p id={stakeErrorId} className="sb-note sb-note--error" role="alert">
                    <AlertTriangle size={14} aria-hidden="true" />
                    Enter an amount in naira, up to two decimal places.
                  </p>
                ) : null}
                {insufficient ? (
                  <p id={stakeErrorId} className="sb-note sb-note--error" role="alert">
                    <AlertTriangle size={14} aria-hidden="true" />
                    Total stake ({naira(totalCostMinor)}) exceeds your balance.{" "}
                    <Link href="/deposit">Add funds</Link> or lower the stake.
                  </p>
                ) : null}
                {moved.length > 0 ? (
                  <p className="sb-note sb-note--warn" role="status">
                    <AlertTriangle size={14} aria-hidden="true" />
                    {moved.length === 1 ? "One price has" : `${moved.length} prices have`} moved since you
                    added {moved.length === 1 ? "it" : "them"}.
                  </p>
                ) : null}

                {isSystemSlip && systemPreview?.valid ? (
                  <dl style={{ margin: 0 }}>
                    <div className="sb-total">
                      <dt>Combinations</dt>
                      <dd>{systemPreview.combinations} bets</dd>
                    </div>
                    <div className="sb-total">
                      <dt>Total stake</dt>
                      <dd>{naira(systemPreview.totalStakeMinor)}</dd>
                    </div>
                    {systemPreview.minWinningReturnMinor > 0n ? (
                      <div className="sb-total">
                        <dt>If {activeSystemSize}/{pickCount} win (min)</dt>
                        <dd>{naira(systemPreview.minWinningReturnMinor)}</dd>
                      </div>
                    ) : null}
                    <div className="sb-total sb-total--major">
                      <dt>Max potential return</dt>
                      <dd>{naira(systemPreview.maxReturnMinor)}</dd>
                    </div>
                  </dl>
                ) : (
                  <dl style={{ margin: 0 }}>
                    <div className="sb-total">
                      <dt>Total odds</dt>
                      <dd>{accaPreview.totalOdds.toFixed(2)}</dd>
                    </div>
                    <div className="sb-total">
                      <dt>Possible profit</dt>
                      <dd>{naira(accaPreview.profitMinor)}</dd>
                    </div>
                    <div className="sb-total sb-total--major">
                      <dt>Potential return</dt>
                      <dd>{naira(accaPreview.returnMinor)}</dd>
                    </div>
                  </dl>
                )}

                <p className="sb-xs sb-muted" style={{ margin: 0 }}>
                  Potential return includes your stake. Final prices are confirmed by the server.
                </p>

                {slip.status === "error" && slip.message ? (
                  <p className="sb-note sb-note--error" role="alert">
                    <AlertTriangle size={14} aria-hidden="true" />
                    {slip.message}
                  </p>
                ) : null}

                {bookedCode ? (
                  <div className="sb-booked-card" role="status">
                    <div className="sb-booked-card__top">
                      <span className="sb-xs sb-muted">Booking Code</span>
                      <strong className="sb-booked-card__code">{bookedCode}</strong>
                    </div>
                    <div className="sb-booked-card__actions">
                      <button
                        type="button"
                        className="sb-btn sb-btn--dark"
                        onClick={() => copyBookingCode(bookedCode)}
                      >
                        {copiedCode ? (
                          <>
                            <Check size={13} aria-hidden="true" /> Copied
                          </>
                        ) : (
                          <>
                            <Copy size={13} aria-hidden="true" /> Copy
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        className="sb-btn sb-btn--ghost"
                        onClick={() => shareBookingCode(bookedCode)}
                      >
                        <Share2 size={13} aria-hidden="true" /> Share
                      </button>
                    </div>
                  </div>
                ) : null}

                {codeFeedback ? (
                  <p
                    className={`sb-note ${
                      codeFeedback.kind === "error"
                        ? "sb-note--error"
                        : codeFeedback.kind === "warn"
                          ? "sb-note--warn"
                          : "sb-note--ok"
                    }`}
                    role="status"
                  >
                    {codeFeedback.text}
                  </p>
                ) : null}

                {!signedIn ? (
                  <Link href="/signin" className="sb-btn sb-btn--primary sb-btn--lg">
                    Sign in to place bet
                  </Link>
                ) : confirming && canPlace ? (
                  <div className="sb-stack">
                    <p className="sb-small sb-bold" style={{ margin: 0 }}>
                      {isSystemSlip && systemPreview?.valid
                        ? `Place ${systemPreview.combinations} ${
                            effectiveMode === "cut1" ? "Cut-1" : "system"
                          } bets for ${naira(systemPreview.totalStakeMinor)} total?`
                        : `Place ${pickCount === 1 ? "this bet" : `this ${pickCount}-fold`} for ${
                            unitStakeMinor !== null ? naira(unitStakeMinor) : "—"
                          }?`}
                    </p>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        type="button"
                        className="sb-btn sb-btn--ghost"
                        style={{ flex: 1 }}
                        onClick={() => setConfirming(false)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="sb-btn sb-btn--primary"
                        style={{ flex: 1 }}
                        onClick={place}
                        disabled={slip.status === "placing"}
                      >
                        {slip.status === "placing" ? (
                          <>
                            <Loader2 size={15} className="sb-spin" aria-hidden="true" /> Placing
                          </>
                        ) : (
                          "Confirm"
                        )}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="sb-btn sb-btn--primary sb-btn--lg"
                    disabled={!canPlace}
                    onClick={() => setConfirming(true)}
                  >
                    {isSystemSlip && systemPreview?.valid && totalCostMinor > 0n
                      ? `Place ${systemPreview.combinations} bets · ${naira(totalCostMinor)}`
                      : "Place bet"}
                  </button>
                )}

                <div className="sb-slip-footer-actions">
                  <button
                    type="button"
                    className="sb-btn sb-btn--dark"
                    onClick={createBookingCode}
                    disabled={bookingBusy}
                  >
                    {bookingBusy ? (
                      <Loader2 size={13} className="sb-spin" aria-hidden="true" />
                    ) : (
                      <Bookmark size={13} aria-hidden="true" />
                    )}
                    <span>Book bet</span>
                  </button>
                  <button
                    type="button"
                    className="sb-btn sb-btn--ghost"
                    onClick={() => setShowLoaderBar((v) => !v)}
                  >
                    Load code
                  </button>
                  <button
                    type="button"
                    className="sb-btn sb-btn--danger"
                    onClick={() => {
                      setConfirming(false);
                      setBookedCode(null);
                      setCodeFeedback(null);
                      setBankerIds([]);
                      setBetMode("acca");
                      slip.clear();
                    }}
                  >
                    Clear
                  </button>
                </div>

                {showLoaderBar ? <div className="sb-booking-box">{bookingForm}</div> : null}

                {balance !== null ? (
                  <div className="sb-row-between">
                    <span className="sb-xs sb-muted">Available balance</span>
                    <span className="sb-xs sb-bold sb-num">{naira(balance)}</span>
                  </div>
                ) : null}

                <p className="sb-xs sb-muted" style={{ margin: 0 }}>
                  18+. Bet responsibly. <Link href="/responsible">Set a limit</Link>.
                </p>
              </div>
            </>
          )}
        </>
      )}

      {compact ? null : null}
    </section>
  );
}
