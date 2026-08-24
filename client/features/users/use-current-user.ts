import { useQuery, useQueryClient } from "@tanstack/react-query";
import { meQuery } from "@/features/system/queries";
import { refreshCurrentUser } from "@/lib/api/query-client";
import type { AuthUser, UserRole } from "@/lib/auth/schemas";
import { useHydrated } from "@/lib/use-hydrated";

export type CurrentUser = {
  user: AuthUser | null;
  role: UserRole | null;
  isPending: boolean;
  isError: boolean;
  refresh: () => Promise<void>;
};

export function useCurrentUser(): CurrentUser {
  const hydrated = useHydrated();
  const queryClient = useQueryClient();
  const query = useQuery(meQuery());
  const refresh = () => refreshCurrentUser(queryClient);

  if (!hydrated) {
    return { user: null, role: null, isPending: true, isError: false, refresh };
  }
  return {
    user: query.data ?? null,
    role: query.data?.role ?? null,
    isPending: query.isPending,
    isError: query.isError,
    refresh,
  };
}
