import type { DefaultSession } from "next-auth";
import type { UserRole, UserStatus } from "@/modules/users/schema";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: UserRole;
      status: UserStatus;
      mustChangePassword: boolean;
    } & DefaultSession["user"];
  }

  interface User {
    role: UserRole;
    status: UserStatus;
    mustChangePassword: boolean;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId: string;
    role: UserRole;
    status: UserStatus;
    mustChangePassword: boolean;
  }
}

export {};

