import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";
import { authOptions } from "@/modules/auth/auth-options";
import { walletForUser } from "@/modules/wallet/lookup";
import { walletService } from "@/modules/wallet/wallet.service";
import { DEFAULT_WITHDRAWAL_LIMITS } from "@/modules/payments/withdrawal.service";
import { WithdrawForm } from "./withdraw-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Withdraw" };

function naira(minor: bigint): string {
  const whole = (minor / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `₦${whole}.${(minor % 100n).toString().padStart(2, "0")}`;
}

export default async function WithdrawPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/api/auth/signin");

  const walletId = await walletForUser(session.user.id);
  if (!walletId) redirect("/wallet");

  const [balanceMinor, [account]] = await Promise.all([
    walletService.getBalance(walletId),
    db.execute<{ kyc_level: number }>(sql`
      SELECT kyc_level FROM users WHERE id = ${session.user.id}::uuid
    `),
  ]);

  const tier = Number(account?.kyc_level ?? 0);
  const dailyCap = DEFAULT_WITHDRAWAL_LIMITS.dailyCapMinor[tier] ?? 0n;

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
        <h1>Withdraw</h1>
        <p className="muted">Available {naira(balanceMinor)}</p>
      </header>

      {dailyCap === 0n ? (
        <section className="card form-card">
          <h2>Verification required</h2>
          <p className="muted small">
            You need to verify your identity before withdrawing. An account that can take money
            out without proving who owns it is a money-laundering route, and we are not permitted
            to allow it.
          </p>
        </section>
      ) : (
        <WithdrawForm
          balanceMinor={balanceMinor.toString()}
          dailyCapMinor={dailyCap.toString()}
          minMinor={DEFAULT_WITHDRAWAL_LIMITS.minWithdrawalMinor.toString()}
          tier={tier}
        />
      )}
    </main>
  );
}
