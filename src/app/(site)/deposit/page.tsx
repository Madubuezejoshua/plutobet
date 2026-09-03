import { redirect } from "next/navigation";
import { eq, and } from "drizzle-orm";
import { getServerSession } from "next-auth";
import { Building2, Clock, ShieldAlert } from "lucide-react";
import { db } from "@/db/pooled";
import { authOptions } from "@/modules/auth/auth-options";
import { virtualAccounts } from "@/modules/payments/schema";
import { PageShell } from "@/components/sportsbook/page-shell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Deposit" };

/**
 * Deposit.
 *
 * Leads with the dedicated virtual account (a permanent NUBAN), not with
 * cards. Bank transfer is the dominant rail in this market and cards are
 * secondary, so the primary path is "transfer to your own account number" —
 * no redirect, no card details, and it works from any banking app.
 *
 * There is no amount field for that path on purpose: the user transfers
 * whatever they like and the webhook attributes it by the account number the
 * money arrived at. The redesign did not add one, and must not: an amount box
 * that changes nothing about what the bank sends is a lie about how this works.
 */
export default async function DepositPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/signin?callbackUrl=%2Fdeposit");

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
    <PageShell
      title="Deposit"
      sub="Transfer from any bank app. Your account number never changes."
      back={{ href: "/wallet", label: "Wallet" }}
      width="narrow"
    >
      {account ? (
        <>
          <section className="sb-panel sb-pad">
            <p className="sb-small sb-muted" style={{ margin: 0 }}>Transfer to</p>
            <p className="sb-accountnumber">{account.accountNumber}</p>

            <dl style={{ margin: 0 }}>
              <div className="sb-total">
                <dt>Bank</dt>
                <dd>{account.bankName}</dd>
              </div>
              <div className="sb-total">
                <dt>Account name</dt>
                <dd>{account.accountName}</dd>
              </div>
            </dl>
          </section>

          <section className="sb-panel sb-pad sb-stack" style={{ marginTop: "var(--sb-3)" }}>
            <p className="sb-note" style={{ background: "var(--sb-surface-3)", color: "var(--sb-ink-2)" }}>
              <Clock size={14} aria-hidden="true" />
              Money sent here credits your wallet automatically, usually within a minute.
            </p>
            <p className="sb-note sb-note--warn">
              <ShieldAlert size={14} aria-hidden="true" />
              Only transfer from an account in your own name. A deposit from a third party cannot
              be credited and has to be returned.
            </p>
          </section>
        </>
      ) : (
        <section className="sb-panel sb-pad sb-stack">
          <h2 style={{ margin: 0, fontSize: "var(--sb-t-lg)", display: "flex", alignItems: "center", gap: 8 }}>
            <Building2 size={17} aria-hidden="true" /> Account not ready
          </h2>
          <p className="sb-small sb-muted" style={{ margin: 0 }}>
            Your dedicated account number is still being created. This normally takes a few
            moments — refresh shortly.
          </p>
          <p className="sb-xs sb-muted" style={{ margin: 0 }}>
            A dedicated account is issued once per player and is permanent, so you only ever need
            to save it once.
          </p>
        </section>
      )}
    </PageShell>
  );
}
