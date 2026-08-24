import type { InfiniteData, QueryClient, QueryKey } from "@tanstack/react-query";
import type { KnownStreamEvent, StreamEventOf } from "@/features/streams/events";
import { qk } from "@/lib/api/query-keys";
import type { RunSummary, RunSummaryPage } from "@/lib/api/types";
import { patchedRun } from "./apply-run-event";
import type { RunListFilters } from "./queries";

type RunListData = InfiniteData<RunSummaryPage, string | null>;

const FILTERS_KEY_POSITION = 2;

const EMPTY_COUNTERS: RunSummary["counters"] = {
  scenarios_total: 0,
  scenarios_done: 0,
  pass: 0,
  fail: 0,
  flaky: 0,
  uncertain: 0,
  skipped: 0,
  steps_recorded: 0,
};

const EMPTY_BUDGET: RunSummary["budget"] = {
  max_usd: 0,
  spent_usd: 0,
  max_minutes: 0,
  elapsed_ms: 0,
};

export function isProvisionalBudget(budget: RunSummary["budget"]): boolean {
  return budget.max_usd === 0 && budget.max_minutes === 0 && budget.elapsed_ms === 0;
}

export function filtersOfListKey(key: QueryKey): RunListFilters {
  const candidate: unknown = key[FILTERS_KEY_POSITION];
  return typeof candidate === "object" && candidate !== null ? (candidate as RunListFilters) : {};
}

function hasEntries(values: readonly unknown[] | undefined): boolean {
  return values !== undefined && values.length > 0;
}

export function runMatchesFilters(
  run: Pick<RunSummary, "target_id" | "status" | "kind" | "plan_id" | "run_group_id">,
  filters: RunListFilters,
): boolean {
  if (filters.target_id !== undefined && filters.target_id !== run.target_id) {
    return false;
  }
  if (filters.plan_id !== undefined && filters.plan_id !== run.plan_id) {
    return false;
  }
  if (filters.run_group_id !== undefined && filters.run_group_id !== run.run_group_id) {
    return false;
  }
  if (hasEntries(filters.status) && !filters.status?.includes(run.status)) {
    return false;
  }
  return !(hasEntries(filters.kind) && !filters.kind?.includes(run.kind));
}

export function provisionalRun(event: StreamEventOf<"run.created">, runId: string): RunSummary {
  return {
    id: runId,
    kind: event.payload.kind,
    target_id: event.payload.target_id,
    plan_id: event.payload.plan_id,
    run_group_id: null,
    status: event.payload.status,
    counters: EMPTY_COUNTERS,
    budget: EMPTY_BUDGET,
    read_only: false,
    started_at: null,
    finished_at: null,
    created_at: event.ts,
  };
}

function containsRun(data: RunListData, runId: string): boolean {
  return data.pages.some((page) => page.items.some((item) => item.id === runId));
}

function prependRun(data: RunListData, run: RunSummary): RunListData {
  return {
    ...data,
    pages: data.pages.map((page, index) =>
      index === 0
        ? {
            ...page,
            items: [run, ...page.items],
            total: page.total === null ? null : page.total + 1,
          }
        : page,
    ),
  };
}

function applyCreated(queryClient: QueryClient, event: StreamEventOf<"run.created">): void {
  const { run_id: runId } = event;
  if (runId !== null) {
    const run = provisionalRun(event, runId);
    for (const [key, data] of queryClient.getQueriesData<RunListData>({
      queryKey: qk.runs.lists(),
    })) {
      if (
        data !== undefined &&
        data.pages.length > 0 &&
        runMatchesFilters(run, filtersOfListKey(key)) &&
        !containsRun(data, runId)
      ) {
        queryClient.setQueryData<RunListData>(key, prependRun(data, run));
      }
    }
  }
  void queryClient.invalidateQueries({ queryKey: qk.runs.lists() });
}

function patchRows(queryClient: QueryClient, runId: string, event: KnownStreamEvent): void {
  queryClient.setQueriesData<RunListData>({ queryKey: qk.runs.lists() }, (data) => {
    if (data === undefined || !containsRun(data, runId)) {
      return data;
    }
    return {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        items: page.items.map((item) => (item.id === runId ? patchedRun(item, event) : item)),
      })),
    };
  });
}

function invalidateStatusFilteredLists(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({
    queryKey: qk.runs.lists(),
    predicate: (query) => hasEntries(filtersOfListKey(query.queryKey).status),
  });
}

export function applyRunFeedEvent(queryClient: QueryClient, event: KnownStreamEvent): void {
  switch (event.type) {
    case "stream.hello":
      void queryClient.invalidateQueries({ queryKey: qk.runs.lists() });
      return;
    case "run.created":
      applyCreated(queryClient, event);
      return;
    case "run.status_changed":
    case "run.finished":
      if (event.run_id !== null) {
        patchRows(queryClient, event.run_id, event);
      }
      invalidateStatusFilteredLists(queryClient);
      return;
    case "run.progress":
    case "budget.updated":
      if (event.run_id !== null) {
        patchRows(queryClient, event.run_id, event);
      }
      return;
    default:
      return;
  }
}
