import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/modules/auth/auth-options";
import { UTILITY_ROUTES } from "@/lib/navigation";
import { describeDevice, sessionService } from "@/modules/users/session.service";
import { SecurityControls, type DeviceRow } from "./security-controls";
import { PageShell } from "@/components/sportsbook/page-shell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Security" };

export default async function SecurityPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect(`${UTILITY_ROUTES.signIn}?callbackUrl=%2Faccount%2Fsecurity`);

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
    <PageShell
      title="Security"
      sub="Your password and every device signed in to this account."
      back={{ href: "/account", label: "Account" }}
      width="narrow"
    >
      <SecurityControls devices={devices} />
    </PageShell>
  );
}
