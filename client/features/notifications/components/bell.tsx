"use client";

import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useHydrated } from "@/lib/use-hydrated";
import { unreadCountOf, unreadNotificationsQuery } from "../queries";
import { NotificationList } from "./notification-list";

const MAX_BADGE_COUNT = 9;

export function formatBadgeCount(count: number): string {
  return count > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : String(count);
}

export function NotificationBell() {
  const hydrated = useHydrated();
  const [open, setOpen] = useState(false);
  const query = useQuery(unreadNotificationsQuery());
  const unread = unreadCountOf(query.data);
  const known = hydrated && query.isSuccess;
  const label = known ? `Notifications, ${unread} unread` : "Notifications";

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={label}
            data-slot="notification-bell"
            className="relative"
          >
            <Bell aria-hidden="true" />
            {known && unread > 0 ? (
              <span
                aria-hidden="true"
                data-slot="notification-count"
                className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-severity-critical-solid px-1 text-[10px] leading-none font-semibold text-severity-critical-solid-fg tabular-nums"
              >
                {formatBadgeCount(unread)}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-96 max-w-[calc(100vw-2rem)] gap-0 p-0">
          <NotificationList query={query} onNavigate={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
      <span role="status" className="sr-only">
        {known ? `${unread} unread ${unread === 1 ? "notification" : "notifications"}` : ""}
      </span>
    </>
  );
}
