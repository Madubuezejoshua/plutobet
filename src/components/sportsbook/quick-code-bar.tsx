"use client";

import { useState } from "react";
import {
  Bookmark,
  CheckCircle2,
  Download,
  Loader2,
  SearchCheck,
  X,
} from "lucide-react";
import { naira } from "@/lib/money";
import { useBetslip, type Pick } from "./betslip-store";

interface BookedSelectionPayload {
  selectionId: string;
  eventId: string;
  fixture: string;
  marketKey: string;
  selectionLabel: string;
  currentPrice: number | null;
  available: boolean;
}

interface VerifiedTicket {
  reference: string;
  status: string;
  stakeMinor: string;
  totalOdds: number;
  potentialReturnMinor: string;
  settledReturnMinor: string | null;
  placedAt: string;
  legs: Array<{
    fixture: string;
    league: string;
    sport: string;
    marketKey: string;
    selectionLabel: string;
    odds: number;
    status: string;
    startsAt: string;
  }>;
}

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  OPEN: { label: "Open", cls: "sb-badge--info" },
  WON: { label: "Won", cls: "sb-badge--ok" },
  LOST: { label: "Lost", cls: "sb-badge--bad" },
  VOID: { label: "Void", cls: "sb-badge--warn" },
  CASHED_OUT: { label: "Cashed Out", cls: "sb-badge--ok" },
};

/**
 * SportyBet / Bet9ja-style inline quick bar:
 * - Tab 1: Load Booking Code straight into the live betslip
 * - Tab 2: Check Ticket status by reference ID (non-PII verification)
 */
export function QuickCodeBar({ defaultMode = "booking" }: { defaultMode?: "booking" | "ticket" }) {
  const slip = useBetslip();
  const [mode, setMode] = useState<"booking" | "ticket">(defaultMode);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "warn" | "error"; text: string } | null>(null);
  const [ticket, setTicket] = useState<VerifiedTicket | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const cleaned = input.trim();
    if (!cleaned) return;

    setBusy(true);
    setMessage(null);
    setTicket(null);

    try {
      if (mode === "booking") {
        const res = await fetch(`/api/bookings?code=${encodeURIComponent(cleaned.toUpperCase())}`);
        const body = (await res.json().catch(() => null)) as
          | {
              error?: string;
              code?: string;
              selections?: BookedSelectionPayload[];
            }
          | null;

        if (!res.ok || !body?.selections) {
          setMessage({
            kind: "error",
            text: body?.error ?? "Booking code not found or expired.",
          });
          return;
        }

        const available: Pick[] = body.selections
          .filter((s) => s.available && typeof s.currentPrice === "number" && s.currentPrice > 1)
          .map((s) => ({
            selectionId: s.selectionId,
            eventId: s.eventId,
            fixture: s.fixture,
            marketKey: s.marketKey,
            selectionKey: s.selectionLabel,
            selectionLabel: s.selectionLabel,
            odds: s.currentPrice!,
            line: null,
          }));

        if (available.length === 0) {
          setMessage({
            kind: "warn",
            text: `Code ${body.code ?? cleaned.toUpperCase()} found, but all selections are closed or settled.`,
          });
          return;
        }

        slip.replacePicks(available);
        const skipped = body.selections.length - available.length;
        setInput("");
        setMessage({
          kind: skipped > 0 ? "warn" : "ok",
          text:
            skipped > 0
              ? `Loaded ${available.length} selection${available.length === 1 ? "" : "s"} into your betslip (${skipped} unavailable skipped).`
              : `Loaded ${available.length} selection${available.length === 1 ? "" : "s"} from code ${body.code ?? cleaned.toUpperCase()} into your betslip.`,
        });
      } else {
        const res = await fetch(`/api/tickets?ref=${encodeURIComponent(cleaned)}`);
        const body = (await res.json().catch(() => null)) as
          | { error?: string; ticket?: VerifiedTicket }
          | null;

        if (!res.ok || !body?.ticket) {
          setMessage({
            kind: "error",
            text: body?.error ?? "Ticket reference not found.",
          });
          return;
        }

        setTicket(body.ticket);
      }
    } catch {
      setMessage({
        kind: "error",
        text: "Could not reach the server. Please try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="sb-panel sb-quickbar" aria-label="Load booking code or check ticket">
      <div className="sb-quickbar__row">
        <div className="sb-quickbar__tabs" role="tablist" aria-label="Quick slip tools">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "booking"}
            className="sb-quickbar__tab"
            onClick={() => {
              setMode("booking");
              setMessage(null);
              setTicket(null);
            }}
          >
            <Bookmark size={13} aria-hidden="true" />
            <span>Load Code</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "ticket"}
            className="sb-quickbar__tab"
            onClick={() => {
              setMode("ticket");
              setMessage(null);
              setTicket(null);
            }}
          >
            <SearchCheck size={13} aria-hidden="true" />
            <span>Check Ticket</span>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="sb-quickbar__form">
          <label className="sb-sr" htmlFor="sb-quickbar-input">
            {mode === "booking" ? "Enter booking code" : "Enter ticket reference"}
          </label>
          <input
            id="sb-quickbar-input"
            type="text"
            value={input}
            onChange={(e) =>
              setInput(mode === "booking" ? e.target.value.toUpperCase() : e.target.value)
            }
            placeholder={
              mode === "booking"
                ? "Paste booking code (e.g. X7K9P2)"
                : "Paste ticket ref (first 8+ chars)"
            }
            autoComplete="off"
            maxLength={40}
            className="sb-quickbar__input"
          />
          <button
            type="submit"
            className="sb-btn sb-btn--primary sb-quickbar__btn"
            disabled={busy || input.trim().length < 3}
          >
            {busy ? (
              <Loader2 size={14} className="sb-spin" aria-hidden="true" />
            ) : mode === "booking" ? (
              <Download size={14} aria-hidden="true" />
            ) : (
              <SearchCheck size={14} aria-hidden="true" />
            )}
            <span>{mode === "booking" ? "Load" : "Verify"}</span>
          </button>
        </form>
      </div>

      {message ? (
        <div
          className={`sb-note sb-quickbar__feedback ${
            message.kind === "error"
              ? "sb-note--error"
              : message.kind === "warn"
                ? "sb-note--warn"
                : "sb-note--ok"
          }`}
          role="status"
        >
          <span>{message.text}</span>
          <button
            type="button"
            className="sb-quickbar__dismiss"
            onClick={() => setMessage(null)}
            aria-label="Dismiss message"
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {ticket ? (
        <div className="sb-ticketcheck" role="region" aria-label="Verified ticket details">
          <div className="sb-ticketcheck__head">
            <div className="sb-ticketcheck__title">
              <CheckCircle2 size={15} aria-hidden="true" style={{ color: "var(--sb-brand-text)" }} />
              <strong>Ticket #{ticket.reference}</strong>
              <span
                className={`sb-badge ${STATUS_BADGE[ticket.status]?.cls ?? "sb-badge--info"}`}
              >
                {STATUS_BADGE[ticket.status]?.label ?? ticket.status}
              </span>
            </div>
            <button
              type="button"
              className="sb-quickbar__dismiss"
              onClick={() => setTicket(null)}
              aria-label="Close ticket result"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>

          <div className="sb-ticketcheck__meta">
            <span>
              Stake: <strong className="sb-num">{naira(ticket.stakeMinor)}</strong>
            </span>
            <span>
              Total Odds: <strong className="sb-num">{ticket.totalOdds.toFixed(2)}</strong>
            </span>
            <span>
              {ticket.settledReturnMinor !== null ? "Settled Return:" : "Potential Return:"}{" "}
              <strong className="sb-num">
                {naira(ticket.settledReturnMinor ?? ticket.potentialReturnMinor)}
              </strong>
            </span>
          </div>

          <ul className="sb-ticketcheck__legs">
            {ticket.legs.map((leg, idx) => (
              <li key={`${leg.fixture}-${idx}`} className="sb-ticketcheck__leg">
                <div>
                  <div className="sb-ticketcheck__fixture">{leg.fixture}</div>
                  <div className="sb-xs sb-muted">
                    {leg.league} · {leg.selectionLabel} @{" "}
                    <span className="sb-num">{leg.odds.toFixed(2)}</span>
                  </div>
                </div>
                <span
                  className={`sb-badge ${STATUS_BADGE[leg.status]?.cls ?? "sb-badge--info"}`}
                >
                  {STATUS_BADGE[leg.status]?.label ?? leg.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
