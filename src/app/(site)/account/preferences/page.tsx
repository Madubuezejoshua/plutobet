import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/modules/auth/auth-options";
import { UTILITY_ROUTES } from "@/lib/navigation";
import { profileService } from "@/modules/users/profile.service";
import { PreferencesForm } from "./preferences-form";
import { PageShell } from "@/components/sportsbook/page-shell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Preferences" };

export default async function PreferencesPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect(`${UTILITY_ROUTES.signIn}?callbackUrl=%2Faccount%2Fpreferences`);

  const preferences = await profileService.preferences(session.user.id);

  return (
    <PageShell
      title="Preferences"
      sub="How odds are shown, and what we contact you about."
      back={{ href: "/account", label: "Account" }}
      width="narrow"
    >
      <PreferencesForm initial={preferences} />
    </PageShell>
  );
}
