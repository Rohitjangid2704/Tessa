import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import type { Run } from "@/lib/api/types";
import { reconcileRunWithEvents } from "./apply-run-event";
import {
  isRunNotFound,
  runBrowserSessionsQuery,
  runEventsTailQuery,
  runQuery,
} from "./run-detail-queries";
import type { RunEventStore } from "./run-event-store";
import { isTerminalRunStatus } from "./run-status";

export type RunBootstrapPhase = "loading" | "not_found" | "error" | "ready";

export interface RunBootstrap {
  phase: RunBootstrapPhase;
  error: unknown;
  run: Run | undefined;
  retry: () => void;
}

export function useRunBootstrap(runId: string, store: RunEventStore): RunBootstrap {
  const queryClient = useQueryClient();
  const loaded = useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().loaded,
    () => false,
  );

  const run = useQuery({ ...runQuery(runId), meta: INLINE_ERROR_META });
  const history = useQuery({
    ...runEventsTailQuery(runId),
    enabled: !loaded,
    meta: INLINE_ERROR_META,
  });
  const sessions = useQuery({ ...runBrowserSessionsQuery(runId), meta: INLINE_ERROR_META });

  const historyPage = history.data;
  const runIsFresh = run.isSuccess && run.isFetchedAfterMount;
  const sessionsSettled = !sessions.isPending;

  useEffect(() => {
    if (loaded || !runIsFresh || historyPage === undefined || !sessionsSettled) {
      return;
    }
    reconcileRunWithEvents(queryClient, runId, historyPage.events);
    const reconciled = queryClient.getQueryData<Run>(qk.runs.detail(runId));
    store.load(historyPage, {
      runTerminal: reconciled !== undefined && isTerminalRunStatus(reconciled.status),
    });
  }, [loaded, runIsFresh, historyPage, sessionsSettled, queryClient, runId, store]);

  const refetchRun = run.refetch;
  const refetchHistory = history.refetch;
  const refetchSessions = sessions.refetch;
  const runFailed = run.isError;
  const historyFailed = history.isError;
  const sessionsFailed = sessions.isError;

  const retry = useCallback(() => {
    if (runFailed) {
      void refetchRun();
    }
    if (historyFailed) {
      void refetchHistory();
    }
    if (sessionsFailed) {
      void refetchSessions();
    }
  }, [runFailed, historyFailed, sessionsFailed, refetchRun, refetchHistory, refetchSessions]);

  if (loaded) {
    return { phase: "ready", error: null, run: run.data, retry };
  }
  if (run.isError) {
    return {
      phase: isRunNotFound(run.error) ? "not_found" : "error",
      error: run.error,
      run: undefined,
      retry,
    };
  }
  if (history.isError) {
    return { phase: "error", error: history.error, run: undefined, retry };
  }
  return { phase: "loading", error: null, run: undefined, retry };
}
