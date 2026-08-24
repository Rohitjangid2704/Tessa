import type { KnownStreamEvent } from "@/features/streams/events";
import type { RunStatus } from "@/lib/api/types";
import { isTerminalRunStatus } from "./run-status";

export type ImportStageId = "fetching" | "validating" | "created";

export type ImportStageState = "pending" | "active" | "done" | "failed";

export interface ImportStage {
  id: ImportStageId;
  label: string;
  state: ImportStageState;
  detail: string | null;
}

export interface ImportFailure {
  code: string | null;
  message: string;
}

export interface ImportProgress {
  stages: ImportStage[];
  failure: ImportFailure | null;
  summary: string;
}

interface StageDefinition {
  id: ImportStageId;
  label: string;
  idleDetail: string;
}

export const IMPORT_STAGES: readonly StageDefinition[] = [
  {
    id: "fetching",
    label: "Fetching from git",
    idleDetail: "Clones the repository once and reads the tessa folder.",
  },
  {
    id: "validating",
    label: "Validating the bundle",
    idleDetail: "Runs the same checks as an upload: validation, completeness and the diff.",
  },
  {
    id: "created",
    label: "Creating the version",
    idleDetail: "Stores the bundle as the next version and deletes the clone.",
  },
];

export const IMPORT_FAILURE_FALLBACK = "The import failed and the run recorded no reason.";

const FAILURE_REASON_PATTERN = /^([a-z][a-z0-9_]*):\s*([\s\S]+)$/;

function stageIndexOf(status: RunStatus): number | null {
  if (status === "planning" || status === "seeding") {
    return 0;
  }
  return status === "running" ? 1 : null;
}

export function parseImportFailure(reason: string | null): ImportFailure {
  const text = reason?.trim() ?? "";
  if (text === "") {
    return { code: null, message: IMPORT_FAILURE_FALLBACK };
  }
  const match = FAILURE_REASON_PATTERN.exec(text);
  return match === null
    ? { code: null, message: text }
    : { code: match[1] ?? null, message: match[2] ?? text };
}

function findFailure(events: readonly KnownStreamEvent[]): ImportFailure {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "run.status_changed" && event.payload.status === "failed") {
      return parseImportFailure(event.payload.reason);
    }
  }
  return { code: null, message: IMPORT_FAILURE_FALLBACK };
}

function summarize(status: RunStatus, stages: readonly ImportStage[]): string {
  if (status === "completed") {
    return "Import finished";
  }
  if (status === "failed") {
    return "Import failed";
  }
  if (isTerminalRunStatus(status)) {
    return "Import stopped";
  }
  if (status === "queued") {
    return "Waiting for a worker";
  }
  const active = stages.find((stage) => stage.state === "active");
  return active === undefined ? "Import in progress" : active.label;
}

export function deriveImportProgress(
  status: RunStatus,
  events: readonly KnownStreamEvent[],
): ImportProgress {
  let reached = -1;
  const reasons = new Map<number, string>();
  for (const event of events) {
    if (event.type !== "run.status_changed") {
      continue;
    }
    const index = stageIndexOf(event.payload.status);
    if (index === null) {
      continue;
    }
    reached = Math.max(reached, index);
    if (event.payload.reason !== null && event.payload.reason !== "") {
      reasons.set(index, event.payload.reason);
    }
  }
  const currentIndex = stageIndexOf(status);
  if (currentIndex !== null) {
    reached = Math.max(reached, currentIndex);
  }
  const completed = status === "completed";
  const stopped = isTerminalRunStatus(status) && !completed;
  const stoppedAt = Math.max(reached, 0);
  const stages = IMPORT_STAGES.map((definition, index): ImportStage => {
    let state: ImportStageState = "pending";
    if (completed || (!stopped && index < reached) || (stopped && index < stoppedAt)) {
      state = "done";
    } else if (stopped && index === stoppedAt) {
      state = "failed";
    } else if (!stopped && index === reached) {
      state = "active";
    }
    return {
      id: definition.id,
      label: definition.label,
      state,
      detail: reasons.get(index) ?? definition.idleDetail,
    };
  });
  return {
    stages,
    failure: status === "failed" ? findFailure(events) : null,
    summary: summarize(status, stages),
  };
}
