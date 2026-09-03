import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import Link from "next/link";
import { ArrowDownToLine, ArrowUpFromLine, ReceiptText } from "lucide-react";
import { authOptions } from "@/modules/auth/auth-options";
import { balancesForUser, walletForUser } from "@/modules/wallet/lookup";
import { walletService } from "@/modules/wallet/wallet.service";
import { naira as formatNaira } from "@/lib/money";
import { PageShell } from "@/components/sportsbook/page-shell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Wallet" };

const LABELS: Record<string, string> = {
  DEPOSIT: "Deposit",
  WITHDRAWAL: "Withdrawal",
  STAKE: "Bet placed",
  PAYOUT: "Winnings",
  REFUND: "Refund",
  BONUS: "Bonus",
  ADJUSTMENT: "Adjustment",
  TRANSFER: "Transfer",
};

/**
 * Wallet statement, rendered from the ledger.
 *
 * Deliberately shows the running balance recorded on each entry rather than
 * recomputing one for display: that column was written under the row lock
 * that produced it, so it is what actually happened. A recomputed figure
 * could disagree with the ledger and there would be no way to tell which was
 * right.
 *
 * The redesign changed the presentation and NOT the arithmetic. Cash, bonus
 * and held funds are still three separate figures, for the reason stated
 * below, and the headline is still cash alone.
 */
export default async function WalletPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/signin?callbackUrl=%2Fwallet");

  const walletId = await walletForUser(session.user.id);
  if (!walletId) {
    return (
      <PageShell title="Wallet" width="narrow">
        <section className="sb-panel sb-pad">
          <p className="sb-muted" style={{ margin: 0 }}>This account has no NGN wallet yet.</p>
        </section>
      </PageShell>
    );
  }

  const [balances, statement] = await Promise.all([
    balancesForUser(session.user.id),
    walletService.getStatement(walletId, { limit: 25 }),
  ]);

  return (
    <PageShell title="Wallet" sub="Your balance and every entry behind it.">
      <section className="sb-balance">
        <p className="sb-balance__label">Cash balance · yours to withdraw</p>
        <p className="sb-balance__value">{formatNaira(balances.cashMinor)}</p>

        <div className="sb-balance__actions">
          <Link href="/deposit" className="sb-btn sb-btn--primary">
            <ArrowDownToLine size={15} aria-hidden="true" /> Deposit
          </Link>
          <Link href="/withdraw" className="sb-btn sb-btn--onshell">
            <ArrowUpFromLine size={15} aria-hidden="true" /> Withdraw
          </Link>
          <Link href="/bets" className="sb-btn sb-btn--onshell">
            <ReceiptText size={15} aria-hidden="true" /> My bets
          </Link>
        </div>
      </section>

      {/*
        Bonus and locked funds are shown separately rather than folded into one
        headline figure. A player who sees a single number and finds at cash-out
        that part of it was bonus credit has been misled at the worst possible
        moment.
      */}
      {balances.bonusMinor > 0n || balances.lockedMinor > 0n ? (
        <div className="sb-stats">
          <div className="sb-stat">
            <span className="sb-stat__label">Cash</span>
            <strong className="sb-stat__value">{formatNaira(balances.cashMinor)}</strong>
            <span className="sb-xs sb-muted">Withdrawable</span>
          </div>
          {balances.bonusMinor > 0n ? (
            <div className="sb-stat">
              <span className="sb-stat__label">Bonus</span>
              <strong className="sb-stat__value">{formatNaira(balances.bonusMinor)}</strong>
              <span className="sb-xs sb-muted">Not withdrawable yet</span>
            </div>
          ) : null}
          {balances.lockedMinor > 0n ? (
            <div className="sb-stat">
              <span className="sb-stat__label">On hold</span>
              <strong className="sb-stat__value">{formatNaira(balances.lockedMinor)}</strong>
              <span className="sb-xs sb-muted">Withdrawal in progress or under review</span>
            </div>
          ) : null}
        </div>
      ) : null}

      <section className="sb-panel">
        <div className="sb-panel__head">
          <h2 className="sb-panel__title">Recent activity</h2>
        </div>

        {statement.entries.length === 0 ? (
          <div className="sb-empty">
            <ReceiptText className="sb-empty__icon" size={26} aria-hidden="true" />
            <p className="sb-empty__title">No transactions yet</p>
            <p className="sb-small">Your deposits, bets and winnings will appear here.</p>
          </div>
        ) : (
          <div className="sb-tablewrap">
            <table className="sb-table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Type</th>
                  <th scope="col" className="sb-table__num">Amount</th>
                  <th scope="col" className="sb-table__num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {statement.entries.map((entry) => {
                  const signed = entry.direction === "CREDIT" ? entry.amountMinor : -entry.amountMinor;
                  return (
                    <tr key={entry.id}>
                      <td>
                        {entry.createdAt.toLocaleString("en-NG", {
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                      <td>{LABELS[entry.type] ?? entry.type}</td>
                      <td
                        className="sb-table__num"
                        style={{ color: signed < 0n ? "var(--sb-danger)" : "var(--sb-up)", fontWeight: 700 }}
                      >
                        {signed > 0n ? "+" : ""}
                        {formatNaira(signed)}
                      </td>
                      <td className="sb-table__num sb-muted">{formatNaira(entry.balanceAfterMinor)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </PageShell>
  );
}
