"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

interface Turn {
  role: "user" | "assistant";
  content: string;
  draft?: { action: string; href: string; detail: string } | null;
  navigate?: { href: string; label: string } | null;
}

const SUGGESTIONS = [
  "What's my balance?",
  "Show me live matches",
  "What does over 2.5 mean?",
  "Find Arsenal",
  "Show my bets",
];

/**
 * The Pluto assistant.
 *
 * A DRAFT is never acted on here. When the assistant prepares a bet or a
 * withdrawal it returns a description and a link, and the customer completes it
 * on the real page — where live prices are read again and every check runs.
 * Confirming inside a chat bubble would mean confirming against numbers that
 * were true when the message was written.
 */
export function PlutoChat({
  signedIn,
  modelName,
  live,
}: {
  signedIn: boolean;
  modelName: string;
  live: boolean;
}) {
  const router = useRouter();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;

    const history: Turn[] = [...turns, { role: "user", content: question }];
    setTurns(history);
    setInput("");
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/ai", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: history.map((turn) => ({ role: turn.role, content: turn.content })),
          // Never carried forward from an earlier turn. Confirmation is
          // per-action, and the confirm button is the only thing that sets it.
          confirmed: false,
        }),
      });

      const body = await response.json();
      if (!response.ok) {
        setError(body.message ?? "I could not answer that.");
        return;
      }

      setTurns([
        ...history,
        {
          role: "assistant",
          content: body.text || "I do not have an answer for that.",
          draft: body.draft,
          navigate: body.navigate,
        },
      ]);

      if (body.navigate?.href) router.push(body.navigate.href);
    } catch {
      setError("Network problem — I could not reach the assistant.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {!live ? (
        <p className="sb-note sb-note--warn">
          <strong>Rules-based mode.</strong> No language model is connected, so Pluto understands
          only a few phrasings — balance, bets, transactions, live matches, promotions, finding a
          fixture, and explaining a market. Everything it says still comes from real data.
        </p>
      ) : null}

      <section className="sb-panel sb-pad">
        {turns.length === 0 ? (
          <>
            <p className="sb-small sb-muted">
              Ask about fixtures, odds, results{signedIn ? ", your balance or your bets" : ""}.
              Pluto can prepare a bet for you to confirm — it can never place one itself.
            </p>
            <div className="sb-chips" style={{ marginTop: 12 }}>
              {SUGGESTIONS.filter((s) => signedIn || !/my|balance/i.test(s)).map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="sb-chip"
                  onClick={() => send(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="sb-stack-3">
            {turns.map((turn, index) => (
              <div
                key={index}
                className={turn.role === "user" ? "chat-turn user" : "chat-turn"}
              >
                <span className="sb-xs sb-bold sb-muted">{turn.role === "user" ? "You" : "Pluto"}</span>
                <p style={{ margin: "4px 0 0", whiteSpace: "pre-wrap" }}>{turn.content}</p>

                {turn.draft ? (
                  <div className="sb-note" style={{ marginTop: 10 }}>
                    <strong>Nothing has been done yet.</strong> {turn.draft.detail}
                    <br />
                    <Link href={turn.draft.href} className="sb-btn sb-btn--primary" style={{ marginTop: 8 }}>
                      Review and confirm
                    </Link>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send(input);
          }}
          style={{ marginTop: 14 }}
        >
          <label className="sb-field" style={{ marginBottom: 8 }}>
           <span className="sb-field__label"><span className="sb-hint">Ask Pluto</span></span>
            <input className="sb-input"
              value={input}
              maxLength={2000}
              placeholder="What's good today?"
              onChange={(e) => setInput(e.target.value)}
              disabled={busy}
            />
          </label>
          <button type="submit" className="sb-btn sb-btn--primary sb-btn--lg" disabled={busy || input.trim().length === 0}>
            {busy ? "Thinking…" : "Send"}
          </button>
        </form>

        {error ? (
          <p className="sb-note sb-note--error" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      <p className="sb-legal" style={{ marginBottom: 40 }}>
        Pluto reads only your own account and public fixture data. It cannot place a bet, move
        money, or change a limit without you confirming it yourself on the relevant page. It will
        never tell you an outcome is certain, because none is. Assistant: {modelName}.
      </p>
    </>
  );
}
