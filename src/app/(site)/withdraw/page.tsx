import { redirect } from "next/navigation";
import Link from "next/link";
import { getServerSession } from "next-auth";
import { sql } from "drizzle-orm";
import { db } from "@/db/pooled";
import { authOptions } from "@/modules/auth/auth-options";
import { balancesForUser, walletForUser } from "@/modules/wallet/lookup";
import { DEFAULT_WITHDRAWAL_LIMITS } from "@/modules/payments/withdrawal.service";
import { WithdrawForm } from "./withdraw-form";
import { naira } from "@/lib/money";
import { PageShell } from "@/components/sportsbook/page-shell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Withdraw" };


export default async function WithdrawPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/signin?callbackUrl=%2Fwithdraw");

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
    <PageShell
      title="Withdraw"
      sub={`Available to withdraw ${naira(balances.withdrawableMinor)}`}
      back={{ href: "/wallet", label: "Wallet" }}
      width="narrow"
    >
      {dailyCap === 0n ? (
        <section className="sb-panel sb-pad sb-stack">
          <h2 style={{ margin: 0, fontSize: "var(--sb-t-lg)" }}>Verification required</h2>
          <p className="sb-small sb-muted" style={{ margin: 0 }}>
            You need to verify your identity before withdrawing. An account that can take money
            out without proving who owns it is a money-laundering route, and we are not permitted
            to allow it.
          </p>
          <Link href="/kyc" className="sb-btn sb-btn--primary sb-btn--lg">
            Verify identity
          </Link>
        </section>
      ) : (
        <WithdrawForm
          balanceMinor={balances.withdrawableMinor.toString()}
          dailyCapMinor={dailyCap.toString()}
          minMinor={DEFAULT_WITHDRAWAL_LIMITS.minWithdrawalMinor.toString()}
          tier={tier}
        />
      )}
    </PageShell>
  );
}
