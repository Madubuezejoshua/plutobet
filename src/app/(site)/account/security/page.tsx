import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/modules/auth/auth-options";
import { UTILITY_ROUTES } from "@/lib/navigation";
import { describeDevice, sessionService } from "@/modules/users/session.service";
import { SecurityControls, type DeviceRow } from "./security-controls";

export const dynamic = "force-dynamic";
export const metadata = { title: "Security" };

export default async function SecurityPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect(UTILITY_ROUTES.signIn);

  const sessions = await sessionService
    .list(session.user.id, session.user.sessionId ?? undefined)
    .catch((error: unknown) => {
      console.error("[account] session list unavailable", error);
      return [];
    });

  const devices: DeviceRow[] = sessions.map((entry) => ({
    id: entry.id,
    device: describeDevice(entry.userAgent),
    ip: entry.ip,
    createdAt: entry.createdAt.toISOString(),
    lastSeenAt: entry.lastSeenAt.toISOString(),
    revokedAt: entry.revokedAt?.toISOString() ?? null,
    revokedReason: entry.revokedReason,
    current: entry.current,
  }));

  return (
    <>
      <header className="page-head">
        <h1>Security</h1>
        <p className="muted">
          <Link href="/account">← Account</Link>
        </p>
      </header>

      <SecurityControls devices={devices} />
    </>
  );
}
