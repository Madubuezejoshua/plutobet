import { and, eq } from "drizzle-orm";
import { db } from "@/db/pooled";
import { wallets } from "./schema";

/**
 * Resolves a user's NGN wallet id.
 *
 * Uses the POOLED client deliberately: this is an ordinary read used to build
 * a request, not part of a money movement. The wallet service still takes its
 * own lock on the unpooled connection when it actually moves anything, so a
 * stale read here cannot cause a double-spend — it can only produce a
 * "wallet not found" that the caller handles.
 */
export async function walletForUser(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: wallets.id })
    .from(wallets)
    .where(and(eq(wallets.userId, userId), eq(wallets.kind, "USER"), eq(wallets.currency, "NGN")))
    .limit(1);
  return row?.id ?? null;
}
