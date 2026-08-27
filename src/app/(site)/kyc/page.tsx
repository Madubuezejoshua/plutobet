import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/modules/auth/auth-options";
import { kycService } from "@/modules/kyc/kyc.service";
import { KycForm } from "./kyc-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Verify your identity" };

const TIER_LABEL: Record<number, string> = {
  0: "Unverified",
  1: "Basic — BVN/NIN confirmed",
  2: "Full — document reviewed",
  3: "Enhanced",
};

export default async function KycPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/api/auth/signin");

  const status = await kycService.statusFor(session.user.id);

  return (
    <>
      <header className="page-head">
        <h1>Verify your identity</h1>
        <p className="muted">
          Current level: <strong>{TIER_LABEL[status.tier] ?? status.tier}</strong>
        </p>
      </header>

      <KycForm
        tier={status.tier}
        hasIdentity={status.hasIdentity}
        pendingDocument={status.document?.status === "PENDING"}
        rejectionNote={status.document?.status === "REJECTED" ? status.document.note : null}
      />
    </>
  );
}
