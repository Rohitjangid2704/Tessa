import type { DefaultSession } from "next-auth";
import type { UserRole } from "@/lib/auth/schemas";

declare module "next-auth" {
  interface User {
    role?: UserRole;
  }

  interface Session {
    user: DefaultSession["user"] & {
      id: string;
      role: UserRole;
    };
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    id?: string;
    role?: UserRole;
  }
}
