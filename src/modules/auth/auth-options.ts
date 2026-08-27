import { eq } from "drizzle-orm";
import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { z } from "zod";
import { db } from "@/db/pooled";
import { USER_ROLES, USER_STATUSES, users } from "@/modules/users/schema";
import type { UserRole, UserStatus } from "@/modules/users/schema";
import { sessionService } from "@/modules/users/session.service";
import { normalizeEmail } from "./email";
import {
  consumeUnknownUserPasswordTiming,
  PASSWORD_MAX_LENGTH,
  verifyPassword,
} from "./password";

const credentialsSchema = z.object({
  email: z.string().min(1).max(512),
  password: z.string().min(1),
  /*
   * Supplied by the sign-in form so a session row can record the device.
   * Client-controlled and therefore never trusted for anything but display:
   * it is truncated, stored, and shown back to the account holder. No
   * decision is made from it.
   */
  userAgent: z.string().max(400).optional(),
  ip: z.string().max(60).optional(),
});
const canonicalEmailSchema = z.string().email().max(320);

/*
 * Claim validation, derived from the schema rather than written out.
 *
 * The previous version listed the three statuses inline, which meant adding a
 * status to the enum silently threw on every session belonging to a user in
 * the new state. Deriving it from USER_STATUSES makes that class of bug
 * impossible.
 */
function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && (USER_ROLES as readonly string[]).includes(value);
}

function isUserStatus(value: unknown): value is UserStatus {
  return typeof value === "string" && (USER_STATUSES as readonly string[]).includes(value);
}

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

        // Recorded only after the credentials are known good, so a failed
        // sign-in never creates a session row.
        const sessionId = await sessionService.start({
          userId: user.id,
          userAgent: parsed.data.userAgent ?? null,
          ip: parsed.data.ip ?? null,
        });

        return {
          id: user.id,
          email: user.email,
          role: user.role,
          status: user.status,
          mustChangePassword: user.mustChangePassword,
          sessionId,
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
        token.sid = user.sessionId ?? null;
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

        /*
         * Revocation check. This is what makes "sign out my other device"
         * real rather than cosmetic — a revoked row here downgrades the token
         * to SUSPENDED, and every authorisation gate in the product already
         * refuses anything that is not ACTIVE.
         *
         * Tokens minted before device sessions existed carry no `sid`. They
         * are left alone rather than force-signed-out; they expire within the
         * 8-hour window on their own.
         */
        if (typeof token.sid === "string") {
          const stillValid = await sessionService
            .touch(token.sid, token.userId)
            .catch((error: unknown) => {
              // A database blip must not sign the whole userbase out. Failing
              // open here is safe because status and role were re-read above,
              // and every money path re-checks them at the service boundary.
              console.error("[auth] session touch failed", error);
              return true;
            });
          if (!stillValid) token.status = "SUSPENDED";
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (
        !session.user ||
        typeof token.userId !== "string" ||
        !isUserRole(token.role) ||
        !isUserStatus(token.status) ||
        typeof token.mustChangePassword !== "boolean"
      ) {
        throw new Error("session token is missing required authorization claims");
      }

      session.user.id = token.userId;
      session.user.role = token.role;
      session.user.status = token.status;
      session.user.mustChangePassword = token.mustChangePassword;
      session.user.sessionId = typeof token.sid === "string" ? token.sid : null;
      return session;
    },
  },
};
