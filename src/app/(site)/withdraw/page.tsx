import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";
import { authOptions } from "@/modules/auth/auth-options";
import { balancesForUser, walletForUser } from "@/modules/wallet/lookup";
import { DEFAULT_WITHDRAWAL_LIMITS } from "@/modules/payments/withdrawal.service";
import { WithdrawForm } from "./withdraw-form";
import { naira } from "@/lib/money";

export const dynamic = "force-dynamic";
export const metadata = { title: "Withdraw" };


export default async function WithdrawPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/api/auth/signin");

  const walletId = await walletForUser(session.user.id);
  if (!walletId) redirect("/wallet");

  // Withdrawable is CASH ONLY — never cash + bonus. Bonus credit carries
  // wagering conditions and is not the customer's money until they are met.
  const [balances, [account]] = await Promise.all([
    balancesForUser(session.user.id),
    db.execute<{ kyc_level: number }>(sql`
      SELECT kyc_level FROM users WHERE id = ${session.user.id}::uuid
    `),
  ]);

  const tier = Number(account?.kyc_level ?? 0);
  const dailyCap = DEFAULT_WITHDRAWAL_LIMITS.dailyCapMinor[tier] ?? 0n;

  return (
    <>
      <header className="page-head">
        <h1>Withdraw</h1>
        <p className="muted">Available to withdraw {naira(balances.withdrawableMinor)}</p>
      </header>

      {dailyCap === 0n ? (
        <section className="card form-card">
          <h2>Verification required</h2>
          <p className="muted small">
            You need to verify your identity before withdrawing. An account that can take money
            out without proving who owns it is a money-laundering route, and we are not permitted
            to allow it.
          </p>
          <a
            className="place"
            href="/kyc"
            style={{ display: "block", textAlign: "center", textDecoration: "none", boxSizing: "border-box" }}
          >
            Verify identity
          </a>
        </section>
      ) : (
        <WithdrawForm
          balanceMinor={balances.withdrawableMinor.toString()}
          dailyCapMinor={dailyCap.toString()}
          minMinor={DEFAULT_WITHDRAWAL_LIMITS.minWithdrawalMinor.toString()}
          tier={tier}
        />
      )}
    </>
  );
}
