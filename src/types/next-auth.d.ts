import type { DefaultSession } from "next-auth";
import type { UserRole, UserStatus } from "@/modules/users/schema";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: UserRole;
      status: UserStatus;
      mustChangePassword: boolean;
      /** Device-session id; null for tokens issued before sessions existed. */
      sessionId: string | null;
    } & DefaultSession["user"];
  }

  interface User {
    role: UserRole;
    status: UserStatus;
    mustChangePassword: boolean;
    sessionId?: string | null;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId: string;
    role: UserRole;
    status: UserStatus;
    mustChangePassword: boolean;
    /** Row in user_sessions. Its absence or revocation invalidates this token. */
    sid?: string | null;
  }
}

export {};
