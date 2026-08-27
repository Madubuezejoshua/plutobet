import { sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db/pooled";
import {
  AdminRequiredError,
  PermissionDeniedError,
  requirePermission,
} from "@/modules/admin/guard";
import { isLivePaymentRail } from "@/modules/payments/factory";
import { naira } from "@/lib/money";
import { WithdrawalReview, type WithdrawalRow } from "./withdrawal-review";

export const dynamic = "force-dynamic";
export const metadata = { title: "Withdrawals" };

export default async function AdminWithdrawalsPage() {
  let identity;
  try {
    identity = await requirePermission("withdrawals.read");
  } catch (error) {
    if (error instanceof AdminRequiredError) redirect("/api/auth/signin");
    if (error instanceof PermissionDeniedError) {
      return (
        <>
          <header className="page-head">
            <h1>Withdrawals</h1>
          </header>
          <p className="notice error">{error.message}</p>
        </>
      );
    }
    throw error;
  }

  const rows = await db.execute<{
    id: string;
    email: string;
    amount_minor: string;
    status: string;
    bank_code: string;
    account_number: string;
    account_name: string;
    kyc_level: number;
    provider: string | null;
    provider_ref: string | null;
    failure_reason: string | null;
    created_at: Date;
  }>(sql`
    SELECT w.id, u.email, w.amount_minor::text AS amount_minor, w.status::text AS status,
           w.bank_code, w.account_number, w.account_name, u.kyc_level,
           w.provider, w.provider_ref, w.failure_reason, w.created_at
    FROM withdrawals w
    JOIN users u ON u.id = w.user_id
    ORDER BY
      -- Pending decisions first: this is a queue, not an archive.
      CASE w.status::text WHEN 'REQUESTED' THEN 0 WHEN 'APPROVED' THEN 1
                          WHEN 'PROCESSING' THEN 2 ELSE 3 END,
      w.created_at ASC
    LIMIT 200
  `);

  const withdrawals: WithdrawalRow[] = rows.map((row) => ({
    id: row.id,
    email: row.email,
    amount: naira(BigInt(row.amount_minor)),
    status: row.status,
    bankCode: row.bank_code,
    accountNumber: row.account_number,
    accountName: row.account_name,
    kycLevel: Number(row.kyc_level ?? 0),
    provider: row.provider,
    providerRef: row.provider_ref,
    failureReason: row.failure_reason,
    createdAt: new Date(row.created_at).toISOString(),
  }));

  const pending = withdrawals.filter((row) => row.status === "REQUESTED").length;

  return (
    <>
      <header className="page-head">
        <h1>Withdrawals</h1>
        <p className="muted">
          {pending} awaiting a decision · {withdrawals.length} shown
        </p>
      </header>

      <WithdrawalReview
        withdrawals={withdrawals}
        canReview={identity.permissions.has("withdrawals.review")}
        liveRail={isLivePaymentRail()}
      />
    </>
  );
}
