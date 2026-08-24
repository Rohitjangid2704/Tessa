import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { polling } from "@/lib/api/polling";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import type { NotificationPage } from "@/lib/api/types";
import { unwrap } from "@/lib/api/unwrap";

export const NOTIFICATION_PAGE_SIZE = 20;

export function unreadNotificationsQuery() {
  return queryOptions({
    queryKey: qk.notifications.unread(),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/notifications", {
          params: { query: { unread: true, limit: NOTIFICATION_PAGE_SIZE, include_total: true } },
          signal,
        }),
      ),
    meta: INLINE_ERROR_META,
    ...polling.notifications,
  });
}

export function unreadCountOf(page: NotificationPage | undefined): number {
  if (page === undefined) {
    return 0;
  }
  return page.total ?? page.items.length;
}
