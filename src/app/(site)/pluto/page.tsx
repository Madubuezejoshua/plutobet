import { getServerSession } from "next-auth";
import { authOptions } from "@/modules/auth/auth-options";
import { aiProvider } from "@/modules/ai/provider";
import { PlutoChat } from "./pluto-chat";
import { PageShell } from "@/components/sportsbook/page-shell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pluto AI" };

export default async function PlutoPage() {
  const session = await getServerSession(authOptions);
  const provider = aiProvider();

  return (
    <PageShell
      title="Pluto AI"
      sub="Ask about fixtures, odds and your account."
      width="narrow"
    >
      <PlutoChat
        signedIn={Boolean(session?.user)}
        modelName={provider.name}
        live={provider.live}
      />
    </PageShell>
  );
}
