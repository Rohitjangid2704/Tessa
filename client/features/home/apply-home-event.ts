import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { provisionalRun } from "@/features/runs/apply-feed-event";
import { patchedRun } from "@/features/runs/apply-run-event";
import type { KnownStreamEvent, StreamEventOf } from "@/features/streams/events";
import { qk } from "@/lib/api/query-keys";
import type { DashboardSummary, NotificationPage } from "@/lib/api/types";

export const HOME_INVALIDATE_THROTTLE_MS = 2000;

const TARGET_KEY_POSITION = 1;
const MUTATION_SUMMARY_SEGMENT = qk.mutation.summary("")[1];

function targetOfDashboardKey(key: QueryKey): string | null {
  const candidate: unknown = key[TARGET_KEY_POSITION];
  return typeof candidate === "string" ? candidate : null;
}

export function applyRunCreated(
  queryClient: QueryClient,
  event: StreamEventOf<"run.created">,
): void {
  const { run_id: runId } = event;
  if (runId === null) {
    return;
  }
  const run = provisionalRun(event, runId);
  for (const [key, data] of queryClient.getQueriesData<DashboardSummary>({
    queryKey: qk.dashboard.all(),
  })) {
    const scope = targetOfDashboardKey(key);
    const outOfScope = scope !== null && scope !== run.target_id;
    if (data === undefined || outOfScope || data.last_runs.some((item) => item.id === runId)) {
      continue;
    }
    queryClient.setQueryData<DashboardSummary>(key, {
      ...data,
      last_runs: [run, ...data.last_runs].slice(0, Math.max(data.last_runs.length, 1)),
    });
  }
}

export function patchDashboardRun(
  queryClient: QueryClient,
  runId: string,
  event: KnownStreamEvent,
): void {
  queryClient.setQueriesData<DashboardSummary>({ queryKey: qk.dashboard.all() }, (data) => {
    if (data === undefined || !data.last_runs.some((item) => item.id === runId)) {
      return data;
    }
    return {
      ...data,
      last_runs: data.last_runs.map((item) => (item.id === runId ? patchedRun(item, event) : item)),
    };
  });
}

export function invalidateHomeQueries(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: qk.dashboard.all() });
  void queryClient.invalidateQueries({
    queryKey: qk.mutation.all(),
    predicate: (query) => query.queryKey[1] === MUTATION_SUMMARY_SEGMENT,
  });
  void queryClient.invalidateQueries({ queryKey: qk.trends.all() });
  void queryClient.invalidateQueries({ queryKey: qk.calibration.all() });
}

function withExtraUnread(page: NotificationPage | undefined): NotificationPage | undefined {
  if (page === undefined || page.total === null) {
    return page;
  }
  return { ...page, total: page.total + 1 };
}

export function bumpUnreadNotifications(queryClient: QueryClient): void {
  queryClient.setQueryData<NotificationPage>(qk.notifications.unread(), withExtraUnread);
  void queryClient.invalidateQueries({ queryKey: qk.notifications.all() });
}
