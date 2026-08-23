import type { KnownStreamEvent } from "@/features/streams/events";
import type {
  ExploreActionKind,
  FindingClass,
  FindingStatus,
  Severity,
} from "@/lib/api/types";

export interface ExploreActionRow {
  seq: number;
  ts: string;
  index: number;
  action: ExploreActionKind;
  target: string | null;
  text: string | null;
  url: string | null;
  rationale: string;
  stepId: string | null;
}

export type CandidateState = "verifying" | "confirmed" | "not_reproduced" | "dropped";

export interface CandidateRow {
  seq: number;
  candidateId: string;
  description: string;
  fromIndex: number;
  toIndex: number;
  state: CandidateState;
  findingId: string | null;
  replayRunScenarioId: string | null;
}

export interface FoundFinding {
  seq: number;
  findingId: string;
  title: string;
  findingClass: FindingClass;
  severity: Severity;
  status: FindingStatus;
}

export interface ExploreSnapshot {
  actions: ExploreActionRow[];
  candidates: CandidateRow[];
  findings: FoundFinding[];
  actionCount: number;
  lastStepId: string | null;
  finishedExploring: boolean;
  stopRequestedAt: string | null;
}

export const EMPTY_EXPLORE_SNAPSHOT: ExploreSnapshot = {
  actions: [],
  candidates: [],
  findings: [],
  actionCount: 0,
  lastStepId: null,
  finishedExploring: false,
  stopRequestedAt: null,
};

function replayRunScenarioIds(events: readonly KnownStreamEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type === "explore.verified" && event.payload.replay_run_scenario_id !== null) {
      ids.add(event.payload.replay_run_scenario_id);
    }
  }
  return ids;
}

function stepIdsByIndex(
  events: readonly KnownStreamEvent[],
  replayIds: ReadonlySet<string>,
): { byIndex: Map<number, string>; last: string | null } {
  const byIndex = new Map<number, string>();
  let explorerScenarioId: string | null = null;
  let last: string | null = null;
  for (const event of events) {
    if (event.type !== "step.recorded" || replayIds.has(event.payload.run_scenario_id)) {
      continue;
    }
    explorerScenarioId ??= event.payload.run_scenario_id;
    if (event.payload.run_scenario_id !== explorerScenarioId) {
      continue;
    }
    byIndex.set(event.payload.index, event.payload.step_id);
    last = event.payload.step_id;
  }
  return { byIndex, last };
}

export function deriveExploreSnapshot(
  events: readonly KnownStreamEvent[],
  runEnded: boolean,
): ExploreSnapshot {
  const { byIndex, last } = stepIdsByIndex(events, replayRunScenarioIds(events));
  const actionsByIndex = new Map<number, ExploreActionRow>();
  const candidatesById = new Map<string, CandidateRow>();
  const findingsById = new Map<string, FoundFinding>();
  let stopRequestedAt: string | null = null;

  for (const event of events) {
    switch (event.type) {
      case "explore.action": {
        const { index, action, target, text, url, rationale } = event.payload;
        actionsByIndex.set(index, {
          seq: event.seq ?? 0,
          ts: event.ts,
          index,
          action,
          target,
          text,
          url,
          rationale,
          stepId: byIndex.get(index) ?? null,
        });
        break;
      }
      case "explore.candidate": {
        const { candidate_id, description, from_index, to_index } = event.payload;
        candidatesById.set(candidate_id, {
          seq: event.seq ?? 0,
          candidateId: candidate_id,
          description,
          fromIndex: from_index,
          toIndex: to_index,
          state: runEnded ? "dropped" : "verifying",
          findingId: null,
          replayRunScenarioId: null,
        });
        break;
      }
      case "explore.verified": {
        const known = candidatesById.get(event.payload.candidate_id);
        if (known !== undefined) {
          candidatesById.set(event.payload.candidate_id, {
            ...known,
            state: event.payload.verified ? "confirmed" : "not_reproduced",
            findingId: event.payload.finding_id,
            replayRunScenarioId: event.payload.replay_run_scenario_id,
          });
        }
        break;
      }
      case "finding.created": {
        const { finding_id, title, class: findingClass, severity, status } = event.payload;
        findingsById.set(finding_id, {
          seq: event.seq ?? 0,
          findingId: finding_id,
          title,
          findingClass,
          severity,
          status,
        });
        break;
      }
      case "run.stop_requested":
        stopRequestedAt ??= event.ts;
        break;
      default:
        break;
    }
  }

  const actions = [...actionsByIndex.values()].sort((left, right) => left.index - right.index);
  return {
    actions,
    candidates: [...candidatesById.values()].sort((left, right) => left.seq - right.seq),
    findings: [...findingsById.values()].sort((left, right) => left.seq - right.seq),
    actionCount: actions.filter((row) => row.action !== "finish").length,
    lastStepId: last,
    finishedExploring: actions.some((row) => row.action === "finish"),
    stopRequestedAt,
  };
}
