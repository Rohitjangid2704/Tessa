"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import { BellOff, Check, CheckCheck } from "lucide-react";
import Link from "next/link";
import { readRequestId } from "@/components/states/request-id";
import { SeverityBadge } from "@/components/status/severity-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LastSeen } from "@/features/findings/components/last-seen";
import { describeApiError } from "@/lib/api/errors";
import type { Notification as AppNotification, NotificationPage } from "@/lib/api/types";
import { useMarkAllNotificationsRead, useMarkNotificationRead } from "../mutations";
import { unreadCountOf } from "../queries";
import { safeAppRoute } from "../safe-link";

export type NotificationListProps = {
  query: UseQueryResult<NotificationPage, Error>;
  onNavigate: () => void;
};

type NotificationRowProps = {
  notification: AppNotification;
  disabled: boolean;
  onMarkRead: (notificationId: string) => void;
  onNavigate: () => void;
};

function NotificationRow({ notification, disabled, onMarkRead, onNavigate }: NotificationRowProps) {
  const route = safeAppRoute(notification.link);
  return (
    <li
      data-slot="notification-row"
      data-severity={notification.severity}
      data-kind={notification.kind}
      className="flex items-start gap-2 border-b px-3 py-2 last:border-b-0"
    >
      <SeverityBadge severity={notification.severity} className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {route === null ? (
          <p className="text-sm font-medium wrap-anywhere">{notification.title}</p>
        ) : (
          <Link
            href={route}
            onClick={() => {
              onMarkRead(notification.id);
              onNavigate();
            }}
            className="text-sm font-medium wrap-anywhere underline-offset-4 hover:underline"
          >
            {notification.title}
          </Link>
        )}
        <p className="line-clamp-3 text-xs wrap-anywhere text-muted-foreground">
          {notification.body}
        </p>
        <p className="text-xs text-muted-foreground">
          <LastSeen value={notification.created_at} />
          {route === null ? " (link not followed)" : ""}
        </p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        disabled={disabled}
        aria-label={`Mark as read: ${notification.title}`}
        onClick={() => onMarkRead(notification.id)}
      >
        <Check aria-hidden="true" />
      </Button>
    </li>
  );
}

function ListLoading() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-3 p-3">
      <span className="sr-only">Loading notifications</span>
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}

function ListFailure({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const requestId = readRequestId(error);
  return (
    <div role="alert" className="flex flex-col items-start gap-2 p-3 text-sm">
      <p className="font-medium text-destructive">Could not load notifications</p>
      <p className="text-muted-foreground">{describeApiError(error)}</p>
      {requestId === null ? null : (
        <p className="font-mono text-xs text-muted-foreground">Request ID: {requestId}</p>
      )}
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function ListEmpty() {
  return (
    <div
      data-slot="notification-empty"
      className="flex flex-col items-center gap-2 px-3 py-8 text-center"
    >
      <BellOff aria-hidden="true" className="size-6 text-muted-foreground" />
      <p className="text-sm font-medium">You are all caught up</p>
      <p className="text-xs text-muted-foreground">New run results and alerts appear here.</p>
    </div>
  );
}

export function NotificationList({ query, onNavigate }: NotificationListProps) {
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const items = query.data?.items ?? [];
  const unread = unreadCountOf(query.data);
  const writeError = markRead.error ?? markAll.error;

  function renderBody() {
    if (query.isPending) {
      return <ListLoading />;
    }
    if (query.isError) {
      return <ListFailure error={query.error} onRetry={() => void query.refetch()} />;
    }
    if (items.length === 0) {
      return <ListEmpty />;
    }
    return (
      <ul aria-label="Unread notifications" className="max-h-96 overflow-y-auto">
        {items.map((notification) => (
          <NotificationRow
            key={notification.id}
            notification={notification}
            disabled={markRead.isPending && markRead.variables === notification.id}
            onMarkRead={(notificationId) => markRead.mutate(notificationId)}
            onNavigate={onNavigate}
          />
        ))}
      </ul>
    );
  }

  return (
    <div data-slot="notification-list" className="flex flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <h2 className="text-sm font-semibold">Notifications</h2>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={unread === 0 || markAll.isPending}
          onClick={() => markAll.mutate()}
        >
          <CheckCheck aria-hidden="true" data-icon="inline-start" />
          Mark all read
        </Button>
      </div>
      {writeError === null ? null : (
        <p role="alert" className="border-b px-3 py-2 text-xs text-destructive">
          Could not update notifications: {describeApiError(writeError)}
        </p>
      )}
      {renderBody()}
      {query.data !== undefined && (query.data.total ?? items.length) > items.length ? (
        <p className="border-t px-3 py-2 text-xs text-muted-foreground">
          Showing the latest {items.length} of {query.data.total} unread notifications.
        </p>
      ) : null}
    </div>
  );
}
