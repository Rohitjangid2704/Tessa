import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import type { Team, User, UserPage } from "@/lib/api/types";
import { unwrap } from "@/lib/api/unwrap";

export const TEAMS_PAGE_LIMIT = 200;
export const USER_OPTIONS_PAGE_LIMIT = 200;
export const USER_OPTIONS_MAX_PAGES = 25;

export interface TeamList {
  items: Team[];
  total: number | null;
  hasMore: boolean;
}

export interface TeamUserOptions {
  users: User[];
  complete: boolean;
}

export function teamsQuery() {
  return queryOptions({
    queryKey: qk.teams.list(),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/teams", {
          params: { query: { limit: TEAMS_PAGE_LIMIT, include_total: true } },
          signal,
        }),
      ),
    select: (page): TeamList => ({
      items: page.items,
      total: page.total,
      hasMore: page.next_cursor !== null,
    }),
    meta: INLINE_ERROR_META,
  });
}

async function fetchAllUsers(signal: AbortSignal): Promise<TeamUserOptions> {
  const users: User[] = [];
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < USER_OPTIONS_MAX_PAGES; pageNumber += 1) {
    const page: UserPage = await unwrap(
      api.GET("/api/v1/users", {
        params: { query: { cursor, limit: USER_OPTIONS_PAGE_LIMIT } },
        signal,
      }),
    );
    users.push(...page.items);
    if (page.next_cursor === null) {
      return { users, complete: true };
    }
    cursor = page.next_cursor;
  }
  return { users, complete: false };
}

export function teamUserOptionsQuery() {
  return queryOptions({
    queryKey: qk.users.list({ for: "team-members", limit: USER_OPTIONS_PAGE_LIMIT }),
    queryFn: ({ signal }) => fetchAllUsers(signal),
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    meta: INLINE_ERROR_META,
  });
}
