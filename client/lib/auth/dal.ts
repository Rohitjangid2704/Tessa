import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "@/auth";
import { routes } from "@/lib/routes";
import type { UserRole } from "./schemas";

export type SessionUser = {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
};

export type VerifiedSession = {
  user: SessionUser;
};

export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const session = await auth();
  const user = session?.user;
  if (!user?.id || !user.email) {
    return null;
  }
  return { id: user.id, email: user.email, name: user.name ?? null, role: user.role };
});

export const verifySession = cache(async (): Promise<VerifiedSession> => {
  const user = await getSessionUser();
  if (!user) {
    redirect(routes.login);
  }
  return { user };
});
