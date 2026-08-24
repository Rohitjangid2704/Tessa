import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { cursorInfiniteOptions } from "@/lib/api/pagination";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import type { UserRole } from "@/lib/auth/schemas";

export const USERS_PAGE_SIZE = 25;
export const ACTIVE_ADMIN_PROBE_LIMIT = 2;

export interface UserListFilters {
  q?: string;
  role?: UserRole[];
  is_active?: boolean;
}

export function usersListQuery(filters: UserListFilters = {}, pageSize = USERS_PAGE_SIZE) {
  return cursorInfiniteOptions({
    queryKey: qk.users.list({ ...filters, limit: pageSize }),
    fetchPage: ({ cursor, signal }) =>
      unwrap(
        api.GET("/api/v1/users", {
          params: { query: { ...filters, cursor, limit: pageSize, include_total: true } },
          signal,
        }),
      ),
  });
}

export function activeAdminsQuery() {
  return queryOptions({
    queryKey: qk.users.list({
      probe: "active-admins",
      role: ["admin"],
      is_active: true,
      limit: ACTIVE_ADMIN_PROBE_LIMIT,
    }),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/users", {
          params: {
            query: {
              role: ["admin"],
              is_active: true,
              limit: ACTIVE_ADMIN_PROBE_LIMIT,
              include_total: true,
            },
          },
          signal,
        }),
      ),
    select: (page) => page.total,
    meta: INLINE_ERROR_META,
  });
}
