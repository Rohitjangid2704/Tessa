import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { safeAppRoute } from "@/features/notifications/safe-link";
import type { StreamEventOf } from "@/features/streams/events";
import { KeyedTrailingThrottle } from "@/lib/keyed-throttle";
import { qk } from "@/lib/api/query-keys";
import { feedPath } from "@/lib/sse/feed-paths";
import type { EventStreamState } from "@/lib/sse/stream";
import { useEventStream } from "@/lib/sse/use-event-stream";
import { HIDDEN_PAGE_GRACE_MS, usePageActivity } from "@/lib/use-page-activity";
import {
  applyRunCreated,
  bumpUnreadNotifications,
  HOME_INVALIDATE_THROTTLE_MS,
  invalidateHomeQueries,
  patchDashboardRun,
} from "./apply-home-event";

const DASHBOARD_THROTTLE_KEY = "dashboard";

export interface BudgetNotice {
  runId: string | null;
  dimension: "usd" | "minutes";
  limit: number;
  actual: number;
}

export interface HomeFeed {
  state: EventStreamState;
  budgetNotice: BudgetNotice | null;
  dismissBudgetNotice: () => void;
}

export function isUrgentSeverity(severity: string): boolean {
  return severity === "high" || severity === "critical";
}

export function useHomeFeed(targetId: string | null): HomeFeed {
  const queryClient = useQueryClient();
  const router = useRouter();
  const active = usePageActivity(HIDDEN_PAGE_GRACE_MS);
  const [throttle] = useState(() => new KeyedTrailingThrottle(HOME_INVALIDATE_THROTTLE_MS));
  const [budgetNotice, setBudgetNotice] = useState<BudgetNotice | null>(null);

  useEffect(() => () => throttle.cancel(), [throttle]);

  function scheduleRefresh(): void {
    throttle.schedule(DASHBOARD_THROTTLE_KEY, () => invalidateHomeQueries(queryClient));
  }

  function announceNotification(payload: StreamEventOf<"notification.created">["payload"]): void {
    bumpUnreadNotifications(queryClient);
    if (!isUrgentSeverity(payload.severity)) {
      return;
    }
    const route = safeAppRoute(payload.link);
    const options = {
      id: payload.notification_id,
      action: route === null ? undefined : { label: "Open", onClick: () => router.push(route) },
    };
    if (payload.severity === "critical") {
      toast.error(payload.title, options);
    } else {
      toast.warning(payload.title, options);
    }
  }

  const state = useEventStream(feedPath("home"), {
    enabled: active,
    query: { target_id: targetId },
    onEvent: (event) => {
      switch (event.type) {
        case "dashboard.invalidate":
        case "finding.created":
          scheduleRefresh();
          return;
        case "run.created":
          applyRunCreated(queryClient, event);
          scheduleRefresh();
          return;
        case "run.status_changed":
          if (event.run_id !== null) {
            patchDashboardRun(queryClient, event.run_id, event);
          }
          return;
        case "run.finished":
          if (event.run_id !== null) {
            patchDashboardRun(queryClient, event.run_id, event);
          }
          scheduleRefresh();
          return;
        case "notification.created":
          announceNotification(event.payload);
          return;
        case "budget.exhausted":
          setBudgetNotice({
            runId: event.run_id,
            dimension: event.payload.dimension,
            limit: event.payload.limit,
            actual: event.payload.actual,
          });
          scheduleRefresh();
          return;
        default:
          return;
      }
    },
    onHello: (_event, context) => {
      if (!context.reconnect) {
        return;
      }
      invalidateHomeQueries(queryClient);
      void queryClient.invalidateQueries({ queryKey: qk.notifications.all() });
    },
  });

  return { state, budgetNotice, dismissBudgetNotice: () => setBudgetNotice(null) };
}
