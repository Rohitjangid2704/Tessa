import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";

export function settingsQuery() {
  return queryOptions({
    queryKey: qk.settings(),
    queryFn: ({ signal }) => unwrap(api.GET("/api/v1/settings", { signal })),
    meta: INLINE_ERROR_META,
  });
}
