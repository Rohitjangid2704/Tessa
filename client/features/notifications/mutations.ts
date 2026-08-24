import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import type { NotificationPage } from "@/lib/api/types";
import { unwrap } from "@/lib/api/unwrap";

type UnreadSnapshot = { previous: NotificationPage | undefined };

export function withoutNotification(
  page: NotificationPage | undefined,
  notificationId: string,
): NotificationPage | undefined {
  if (page === undefined) {
    return page;
  }
  const items = page.items.filter((item) => item.id !== notificationId);
  const removed = page.items.length - items.length;
  return {
    ...page,
    items,
    total: page.total === null ? null : Math.max(0, page.total - removed),
  };
}

export function withoutAnyNotification(
  page: NotificationPage | undefined,
): NotificationPage | undefined {
  if (page === undefined) {
    return page;
  }
  return { ...page, items: [], total: page.total === null ? null : 0 };
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: (notificationId: string) =>
      unwrap(
        api.POST("/api/v1/notifications/{notification_id}/read", {
          params: { path: { notification_id: notificationId } },
        }),
      ),
    onMutate: async (notificationId): Promise<UnreadSnapshot> => {
      await queryClient.cancelQueries({ queryKey: qk.notifications.unread() });
      const previous = queryClient.getQueryData<NotificationPage>(qk.notifications.unread());
      queryClient.setQueryData<NotificationPage>(qk.notifications.unread(), (page) =>
        withoutNotification(page, notificationId),
      );
      return { previous };
    },
    onError: (_error, _notificationId, snapshot) => {
      if (snapshot?.previous !== undefined) {
        queryClient.setQueryData(qk.notifications.unread(), snapshot.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qk.notifications.all() });
    },
  });
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: () => unwrap(api.POST("/api/v1/notifications/read-all")),
    onMutate: async (): Promise<UnreadSnapshot> => {
      await queryClient.cancelQueries({ queryKey: qk.notifications.unread() });
      const previous = queryClient.getQueryData<NotificationPage>(qk.notifications.unread());
      queryClient.setQueryData<NotificationPage>(qk.notifications.unread(), withoutAnyNotification);
      return { previous };
    },
    onError: (_error, _variables, snapshot) => {
      if (snapshot?.previous !== undefined) {
        queryClient.setQueryData(qk.notifications.unread(), snapshot.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qk.notifications.all() });
    },
  });
}
