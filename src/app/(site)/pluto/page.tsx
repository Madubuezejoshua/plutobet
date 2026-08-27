import { getServerSession } from "next-auth";
import { authOptions } from "@/modules/auth/auth-options";
import { aiProvider } from "@/modules/ai/provider";
import { PlutoChat } from "./pluto-chat";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pluto AI" };

export default async function PlutoPage() {
  const session = await getServerSession(authOptions);
  const provider = aiProvider();

  return (
    <>
      <header className="page-head">
        <h1>Pluto AI</h1>
        <p className="muted">Ask about fixtures, odds and your account.</p>
      </header>

      <PlutoChat
        signedIn={Boolean(session?.user)}
        modelName={provider.name}
        live={provider.live}
      />
    </>
  );
}
