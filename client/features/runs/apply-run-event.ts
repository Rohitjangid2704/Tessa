import type { QueryClient } from "@tanstack/react-query";
import { persistenceOf, type KnownStreamEvent } from "@/features/streams/events";
import { qk } from "@/lib/api/query-keys";
import type { Run, RunScenario, RunSummary, Step } from "@/lib/api/types";
import type { AppendOutcome, PersistedRunEvent, RunEventStore } from "./run-event-store";
import { isTerminalRunStatus } from "./run-status";

export type ApplyRunEventResult = AppendOutcome | { outcome: "ephemeral" };

export function isPersistedRunEvent(event: KnownStreamEvent): event is PersistedRunEvent {
  return event.seq !== null && persistenceOf(event.type) === "persisted";
}

function startedAtAfter(
  run: RunSummary,
  status: RunSummary["status"],
  timestamp: string,
): string | null {
  if (run.started_at !== null || status === "queued") {
    return run.started_at;
  }
  return timestamp;
}

export function patchedRun<Summary extends RunSummary>(
  run: Summary,
  event: KnownStreamEvent,
): Summary {
  switch (event.type) {
    case "run.status_changed":
      return {
        ...run,
        status: event.payload.status,
        started_at: startedAtAfter(run, event.payload.status, event.ts),
      };
    case "run.progress":
      return { ...run, counters: event.payload };
    case "budget.updated":
      return { ...run, budget: event.payload };
    case "run.finished":
      return {
        ...run,
        status: event.payload.status,
        counters: event.payload.counters,
        budget: { ...run.budget, spent_usd: event.payload.spent_usd },
        started_at: run.started_at ?? event.ts,
        finished_at: run.finished_at ?? event.ts,
      };
    default:
      return run;
  }
}

export function patchRunFromEvent(
  queryClient: QueryClient,
  runId: string,
  event: PersistedRunEvent,
): void {
  queryClient.setQueryData<Run>(qk.runs.detail(runId), (run) => {
    if (run === undefined) {
      return run;
    }
    return {
      ...patchedRun(run, event),
      event_head_seq: Math.max(run.event_head_seq, event.seq),
      stop_requested_at:
        event.type === "run.stop_requested"
          ? (run.stop_requested_at ?? event.ts)
          : run.stop_requested_at,
    };
  });
}

export function reconcileRunWithEvents(
  queryClient: QueryClient,
  runId: string,
  events: readonly KnownStreamEvent[],
): void {
  const cached = queryClient.getQueryData<Run>(qk.runs.detail(runId));
  if (cached === undefined) {
    return;
  }
  const newer = events
    .filter(isPersistedRunEvent)
    .filter((event) => event.seq > cached.event_head_seq);
  for (const event of newer) {
    patchRunFromEvent(queryClient, runId, event);
  }
}

export function refreshRunFromRest(queryClient: QueryClient, runId: string): void {
  void queryClient.invalidateQueries({ queryKey: qk.runs.detail(runId) });
  void queryClient.invalidateQueries({ queryKey: qk.runs.scenarios(runId) });
  void queryClient.invalidateQueries({ queryKey: qk.runs.browserSessions(runId) });
  void queryClient.invalidateQueries({ queryKey: qk.runs.stats(runId) });
  void queryClient.invalidateQueries({ queryKey: qk.runs.invariants(runId) });
  void queryClient.invalidateQueries({ queryKey: qk.runs.lists() });
}

function patchRunScenarioDetail(
  queryClient: QueryClient,
  runScenarioId: string,
  patch: (detail: RunScenario) => RunScenario,
): void {
  queryClient.setQueryData<RunScenario>(qk.runScenarios.detail(runScenarioId), (detail) =>
    detail === undefined ? detail : patch(detail),
  );
}

function patchGradedRows(queryClient: QueryClient, event: PersistedRunEvent): void {
  if (event.type === "step.graded") {
    const { step_id: stepId, run_scenario_id: runScenarioId, verdict } = event.payload;
    patchRunScenarioDetail(queryClient, runScenarioId, (detail) => ({
      ...detail,
      steps: detail.steps.map((step) => (step.id === stepId ? { ...step, verdict } : step)),
    }));
    queryClient.setQueryData<Step>(qk.steps.detail(stepId), (step) =>
      step === undefined ? step : { ...step, verdict },
    );
    return;
  }
  if (event.type === "scenario.verdict") {
    const { run_scenario_id: runScenarioId, attempt, verdict } = event.payload;
    patchRunScenarioDetail(queryClient, runScenarioId, (detail) => ({
      ...detail,
      attempts: detail.attempts.map((entry) =>
        entry.attempt === attempt ? { ...entry, verdict } : entry,
      ),
    }));
  }
}

function invalidateThrottled(
  queryClient: QueryClient,
  store: RunEventStore,
  key: string,
  queryKey: readonly unknown[],
): void {
  store.scheduleInvalidation(key, () => {
    void queryClient.invalidateQueries({ queryKey });
  });
}

function invalidateStatsThrottled(
  queryClient: QueryClient,
  store: RunEventStore,
  key: string,
  queryKey: readonly unknown[],
): void {
  store.scheduleStatsInvalidation(key, () => {
    void queryClient.invalidateQueries({ queryKey });
  });
}

function scheduleInvalidations(
  queryClient: QueryClient,
  store: RunEventStore,
  event: PersistedRunEvent,
): void {
  const { runId } = store;
  switch (event.type) {
    case "invariant.result":
      invalidateStatsThrottled(queryClient, store, "run-stats", qk.runs.stats(runId));
      invalidateStatsThrottled(queryClient, store, "run-invariants", qk.runs.invariants(runId));
      return;
    case "scenario.queued":
    case "scenario.started":
    case "scenario.verdict":
    case "scenario.finished":
    case "step.recorded":
    case "step.graded":
      invalidateThrottled(queryClient, store, "run-scenarios", qk.runs.scenarios(runId));
      invalidateThrottled(
        queryClient,
        store,
        `run-scenario:${event.payload.run_scenario_id}`,
        qk.runScenarios.detail(event.payload.run_scenario_id),
      );
      if (event.type === "step.graded") {
        invalidateThrottled(
          queryClient,
          store,
          `step:${event.payload.step_id}`,
          qk.steps.detail(event.payload.step_id),
        );
      }
      if (event.type === "scenario.finished") {
        invalidateStatsThrottled(queryClient, store, "run-stats", qk.runs.stats(runId));
        invalidateStatsThrottled(queryClient, store, "run-invariants", qk.runs.invariants(runId));
      }
      return;
    case "browser_session.started":
    case "browser_session.ended":
      invalidateThrottled(queryClient, store, "browser-sessions", qk.runs.browserSessions(runId));
      return;
    default:
      return;
  }
}

function settleRunRest(queryClient: QueryClient, store: RunEventStore, event: PersistedRunEvent) {
  if (event.type === "run.finished") {
    store.flushScheduled();
    refreshRunFromRest(queryClient, store.runId);
    return;
  }
  if (event.type === "run.status_changed" && isTerminalRunStatus(event.payload.status)) {
    refreshRunFromRest(queryClient, store.runId);
  }
}

export function applyRunEvent(
  queryClient: QueryClient,
  store: RunEventStore,
  event: KnownStreamEvent,
): ApplyRunEventResult {
  if (!isPersistedRunEvent(event)) {
    if (event.type.startsWith("stream.")) {
      store.recordStreamEvent(event);
    }
    return { outcome: "ephemeral" };
  }

  const result = store.append(event);
  if (result.outcome !== "applied") {
    return result;
  }
  patchRunFromEvent(queryClient, store.runId, event);
  patchGradedRows(queryClient, event);
  scheduleInvalidations(queryClient, store, event);
  settleRunRest(queryClient, store, event);
  return result;
}
