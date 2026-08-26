import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/modules/auth/auth-options";
import { walletForUser } from "@/modules/wallet/lookup";
import { walletService } from "@/modules/wallet/wallet.service";

export const dynamic = "force-dynamic";

function formatNaira(minor: bigint): string {
  const sign = minor < 0n ? "-" : "";
  const abs = minor < 0n ? -minor : minor;
  const naira = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}₦${naira}.${(abs % 100n).toString().padStart(2, "0")}`;
}

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
      <main className="shell">
        <section className="card empty">
          <p>This account has no NGN wallet yet.</p>
        </section>
      </main>
    );
  }

  const [balanceMinor, statement] = await Promise.all([
    walletService.getBalance(walletId),
    walletService.getStatement(walletId, { limit: 25 }),
  ]);

  return (
    <main className="shell">
      <nav className="nav" aria-label="Primary navigation">
        <div className="brand">Bet Platform</div>
        <div className="nav-links">
          <a href="/sports">Sports</a>
          <a href="/bets">My bets</a>
          <a href="/wallet">Wallet</a>
          <a href="/deposit">Deposit</a>
        </div>
      </nav>

      <header className="page-head">
        <h1>Wallet</h1>
        <p className="balance">{formatNaira(balanceMinor)}</p>
        <p className="muted small">Available balance</p>
      </header>

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
    </main>
  );
}
