import { redirect } from "next/navigation";
import { eq, and } from "drizzle-orm";
import { getServerSession } from "next-auth";
import { db } from "@/db/pooled";
import { authOptions } from "@/modules/auth/auth-options";
import { virtualAccounts } from "@/modules/payments/schema";

export const dynamic = "force-dynamic";
export const metadata = { title: "Deposit" };

/**
 * Deposit.
 *
 * Leads with the dedicated virtual account (a permanent NUBAN), not with
 * cards. §8: bank transfer is the dominant rail in this market and cards are
 * secondary, so the primary path is "transfer to your own account number" —
 * no redirect, no card details, and it works from any banking app.
 *
 * There is no amount field for that path on purpose: the user transfers
 * whatever they like and the webhook attributes it by the account number the
 * money arrived at.
 */
export default async function DepositPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/api/auth/signin");

  const [account] = await db
    .select()
    .from(virtualAccounts)
    .where(
      and(
        eq(virtualAccounts.userId, session.user.id),
        eq(virtualAccounts.provider, "paystack"),
      ),
    )
    .limit(1);

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
        <h1>Deposit</h1>
        <p className="muted">Transfer from any bank app. Your account number never changes.</p>
      </header>

      {account ? (
        <section className="card form-card">
          <p className="muted small">Transfer to</p>
          <p className="account-number">{account.accountNumber}</p>
          <dl className="totals">
            <div>
              <dt>Bank</dt>
              <dd>{account.bankName}</dd>
            </div>
            <div>
              <dt>Account name</dt>
              <dd>{account.accountName}</dd>
            </div>
          </dl>
          <p className="muted small legal">
            Money sent here credits your wallet automatically, usually within a minute. Only
            transfer from an account in your own name — deposits from a third party cannot be
            credited and must be returned.
          </p>
        </section>
      ) : (
        <section className="card form-card">
          <h2>Account not ready</h2>
          <p className="muted small">
            Your dedicated account number is still being created. This normally takes a few
            moments — refresh shortly.
          </p>
          <p className="muted small legal">
            A dedicated account is issued once per player and is permanent, so you only ever need
            to save it once.
          </p>
        </section>
      )}
    </main>
  );
}
