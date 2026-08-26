import { eq } from "drizzle-orm";
import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { z } from "zod";
import { db } from "@/db/pooled";
import { users } from "@/modules/users/schema";
import { normalizeEmail } from "./email";
import {
  consumeUnknownUserPasswordTiming,
  PASSWORD_MAX_LENGTH,
  verifyPassword,
} from "./password";

const credentialsSchema = z.object({
  email: z.string().min(1).max(512),
  password: z.string().min(1),
});
const canonicalEmailSchema = z.string().email().max(320);

function requiredAuthSecret(): string {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET is required; authentication has no default secret");
  }
  if (secret.length < 32) {
    throw new Error("AUTH_SECRET must be at least 32 characters");
  }
  return secret;
}

export const authOptions: NextAuthOptions = {
  get secret() {
    return requiredAuthSecret();
  },
  session: {
    strategy: "jwt",
    maxAge: 8 * 60 * 60,
  },
  jwt: {
    maxAge: 8 * 60 * 60,
  },
  providers: [
    CredentialsProvider({
      name: "Email and password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(rawCredentials) {
        const parsed = credentialsSchema.safeParse(rawCredentials);
        if (!parsed.success) return null;
        if (Array.from(parsed.data.password).length > PASSWORD_MAX_LENGTH) return null;

        const canonicalEmail = canonicalEmailSchema.safeParse(normalizeEmail(parsed.data.email));
        if (!canonicalEmail.success) return null;
        const email = canonicalEmail.data;
        const [user] = await db
          .select({
            id: users.id,
            email: users.email,
            passwordHash: users.passwordHash,
            role: users.role,
            status: users.status,
            mustChangePassword: users.mustChangePassword,
          })
          .from(users)
          .where(eq(users.email, email))
          .limit(1);

        if (!user) {
          await consumeUnknownUserPasswordTiming(parsed.data.password);
          return null;
        }

        // Verify before checking status so callers cannot distinguish a
        // suspended/self-excluded account from another invalid credential.
        const passwordMatches = await verifyPassword(user.passwordHash, parsed.data.password);
        if (!passwordMatches || user.status !== "ACTIVE") return null;

        return {
          id: user.id,
          email: user.email,
          role: user.role,
          status: user.status,
          mustChangePassword: user.mustChangePassword,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.userId = user.id;
        token.role = user.role;
        token.status = user.status;
        token.mustChangePassword = user.mustChangePassword;
        return token;
      }

      // JWT sessions avoid mutable session tables, but authorization state is
      // never trusted for the full token lifetime. Re-read it so suspension,
      // self-exclusion, role changes, and forced password changes take effect
      // on the next authenticated request.
      if (typeof token.userId === "string") {
        const [current] = await db
          .select({
            role: users.role,
            status: users.status,
            mustChangePassword: users.mustChangePassword,
          })
          .from(users)
          .where(eq(users.id, token.userId))
          .limit(1);
        token.role = current?.role ?? "USER";
        token.status = current?.status ?? "SUSPENDED";
        token.mustChangePassword = current?.mustChangePassword ?? true;
      }
      return token;
    },
    async session({ session, token }) {
      if (
        !session.user ||
        typeof token.userId !== "string" ||
        (token.role !== "USER" && token.role !== "ADMIN") ||
        (token.status !== "ACTIVE" &&
          token.status !== "SUSPENDED" &&
          token.status !== "SELF_EXCLUDED") ||
        typeof token.mustChangePassword !== "boolean"
      ) {
        throw new Error("session token is missing required authorization claims");
      }

      session.user.id = token.userId;
      session.user.role = token.role;
      session.user.status = token.status;
      session.user.mustChangePassword = token.mustChangePassword;
      return session;
    },
  },
};
