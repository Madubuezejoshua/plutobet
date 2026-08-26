import { getServerSession } from "next-auth";
import { authOptions } from "./auth-options";

export class ActiveSessionRequiredError extends Error {
  constructor() {
    super("an active authenticated session is required");
    this.name = "ActiveSessionRequiredError";
  }
}

export async function requireActiveSession() {
  const session = await getServerSession(authOptions);
  if (!session?.user || session.user.status !== "ACTIVE") {
    throw new ActiveSessionRequiredError();
  }
  return session;
}
