import { redirect } from "next/navigation";
import {
  AdminRequiredError,
  PermissionDeniedError,
  requirePermission,
} from "@/modules/admin/guard";
import { kycService } from "@/modules/kyc/kyc.service";
import { KycReviewActions } from "./kyc-review-actions";

export const dynamic = "force-dynamic";

/**
 * Manual document review queue.
 *
 * No automated document checker is wired up (Dojah or similar), so every
 * tier-2 upgrade goes through a human looking at the signed document link
 * here and clicking approve or reject.
 */
export default async function AdminKycPage() {
  try {
    await requirePermission("kyc.review");
  } catch (error) {
    if (error instanceof AdminRequiredError) redirect("/api/auth/signin");
    if (error instanceof PermissionDeniedError) {
      return (
        <>
          <header className="page-head">
            <h1>KYC document review</h1>
          </header>
          <p className="notice error">{error.message}</p>
        </>
      );
    }
    throw error;
  }

  const pending = await kycService.listPendingReviews();
  const withLinks = await Promise.all(
    pending.map(async (record) => ({
      ...record,
      documentUrl: await kycService.reviewUrlFor(record.id),
    })),
  );

  return (
    <>
      <header className="page-head">
        <h1>KYC document review</h1>
        <p className="muted">{withLinks.length} awaiting a decision</p>
      </header>

      <section className="card">
        {withLinks.length === 0 ? (
          <p className="muted small">Nothing waiting on review.</p>
        ) : (
          <table className="statement">
            <thead>
              <tr>
                <th scope="col">Submitted</th>
                <th scope="col">Account</th>
                <th scope="col">Document</th>
                <th scope="col">Decision</th>
              </tr>
            </thead>
            <tbody>
              {withLinks.map((record) => (
                <tr key={record.id}>
                  <td className="muted">{new Date(record.createdAt).toLocaleString("en-NG")}</td>
                  <td>{record.email}</td>
                  <td>
                    {record.documentUrl ? (
                      <a href={record.documentUrl} target="_blank" rel="noreferrer">
                        View document
                      </a>
                    ) : (
                      <span className="muted small">Link expired — reload</span>
                    )}
                    <p className="muted small">Link valid 5 minutes.</p>
                  </td>
                  <td>
                    <KycReviewActions kycRecordId={record.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
