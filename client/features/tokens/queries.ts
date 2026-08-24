import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";

export function myTokensQuery() {
  return queryOptions({
    queryKey: qk.tokens.mine(),
    queryFn: ({ signal }) => unwrap(api.GET("/api/v1/users/me/tokens", { signal })),
    select: (list) => list.items,
    meta: INLINE_ERROR_META,
  });
}

export function userTokensQuery(userId: string) {
  return queryOptions({
    queryKey: qk.tokens.forUser(userId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/users/{user_id}/tokens", {
          params: { path: { user_id: userId } },
          signal,
        }),
      ),
    select: (list) => list.items,
    meta: INLINE_ERROR_META,
  });
}
