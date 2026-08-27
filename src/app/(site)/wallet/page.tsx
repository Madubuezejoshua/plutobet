import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/modules/auth/auth-options";
import Link from "next/link";
import { balancesForUser, walletForUser } from "@/modules/wallet/lookup";
import { walletService } from "@/modules/wallet/wallet.service";
import { naira as formatNaira } from "@/lib/money";

export const dynamic = "force-dynamic";

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
 */
export default async function WalletPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/api/auth/signin");

  const walletId = await walletForUser(session.user.id);
  if (!walletId) {
    return (
      <>
        <section className="card empty">
          <p>This account has no NGN wallet yet.</p>
        </section>
      </>
    );
  }

  const [balances, statement] = await Promise.all([
    balancesForUser(session.user.id),
    walletService.getStatement(walletId, { limit: 25 }),
  ]);

  return (
    <>
      <header className="page-head">
        <h1>Wallet</h1>
        <p className="balance">{formatNaira(balances.cashMinor)}</p>
        <p className="muted small">Cash balance · yours to withdraw</p>
      </header>

      {/*
        Bonus and locked funds are shown separately rather than folded into one
        headline figure. A player who sees a single number and finds at cash-out
        that part of it was bonus credit has been misled at the worst possible
        moment.
      */}
      {balances.bonusMinor > 0n || balances.lockedMinor > 0n ? (
        <section className="metrics">
          <div className="card metric">
            <span className="metric-label">Cash</span>
            <strong className="metric-value">{formatNaira(balances.cashMinor)}</strong>
            <span className="muted small">Withdrawable</span>
          </div>
          {balances.bonusMinor > 0n ? (
            <div className="card metric">
              <span className="metric-label">Bonus</span>
              <strong className="metric-value">{formatNaira(balances.bonusMinor)}</strong>
              <span className="muted small">Not withdrawable yet</span>
            </div>
          ) : null}
          {balances.lockedMinor > 0n ? (
            <div className="card metric">
              <span className="metric-label">On hold</span>
              <strong className="metric-value">{formatNaira(balances.lockedMinor)}</strong>
              <span className="muted small">Withdrawal in progress or under review</span>
            </div>
          ) : null}
        </section>
      ) : null}

      <p style={{ display: "flex", gap: 10, margin: "4px 0 16px" }}>
        <Link href="/deposit" className="btn primary">Deposit</Link>
        <Link href="/withdraw" className="btn ghost">Withdraw</Link>
      </p>

      <section className="card">
        <h2>Recent activity</h2>
        {statement.entries.length === 0 ? (
          <p className="muted small">No transactions yet.</p>
        ) : (
          <table className="statement">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Type</th>
                <th scope="col" className="right">Amount</th>
                <th scope="col" className="right">Balance</th>
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
                    <td className={signed < 0n ? "right debit" : "right credit"}>
                      {signed > 0n ? "+" : ""}
                      {formatNaira(signed)}
                    </td>
                    <td className="right muted">{formatNaira(entry.balanceAfterMinor)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
