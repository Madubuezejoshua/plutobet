import Link from "next/link";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/modules/auth/auth-options";
import { UTILITY_ROUTES } from "@/lib/navigation";
import { profileService } from "@/modules/users/profile.service";
import { PreferencesForm } from "./preferences-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Preferences" };

export default async function PreferencesPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect(UTILITY_ROUTES.signIn);

  const preferences = await profileService.preferences(session.user.id);

  return (
    <>
      <header className="page-head">
        <h1>Preferences</h1>
        <p className="muted">
          <Link href="/account">← Account</Link>
        </p>
      </header>

      <PreferencesForm initial={preferences} />
    </>
  );
}
