import { ApiError, describeApiError, isApiError, type DependencyName } from "@/lib/api/errors";
import type { RunSocketStatus } from "@/lib/ws/socket";
import type { KnownStreamEvent } from "@/features/streams/events";
import type { LiveState } from "@/components/status/status-types";
import { toLiveState } from "@/features/streams/live-state";

export type HelloPhase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "connecting"; detail: string }
  | { kind: "streaming" }
  | { kind: "reconnecting"; attempt: number; detail: string }
  | { kind: "resyncing" }
  | { kind: "finished" }
  | { kind: "failed"; message: string }
  | { kind: "unavailable"; dependency: DependencyName | null; message: string };

export interface HelloPhaseInput {
  runId: string | null;
  startPending: boolean;
  startError: unknown;
  historyPending: boolean;
  historyError: unknown;
  socketStatus: RunSocketStatus | null;
  socketMessage: string | null;
  socketAttempt: number;
  finishedStatus: string | null;
}

const RUN_FAILED_STATUSES = new Set(["failed", "canceled", "budget_exceeded"]);

export function findFinishedStatus(events: readonly KnownStreamEvent[]): string | null {
  for (const event of events) {
    if (event.type === "run.finished") {
      return event.payload.status;
    }
  }
  return null;
}

function describeStartFailure(error: unknown): HelloPhase {
  if (isApiError(error) && error.status === 503 && error.code === "dependency_unavailable") {
    return {
      kind: "unavailable",
      dependency: error.dependency,
      message: describeApiError(error),
    };
  }
  return { kind: "failed", message: describeApiError(error) };
}

function describeHistoryFailure(error: unknown): HelloPhase {
  if (error instanceof ApiError && error.status === 404) {
    return { kind: "failed", message: "This run was not found" };
  }
  return { kind: "failed", message: describeApiError(error) };
}

export function deriveHelloPhase(input: HelloPhaseInput): HelloPhase {
  if (input.startPending) {
    return { kind: "starting" };
  }
  if (input.startError !== null && input.startError !== undefined && input.runId === null) {
    return describeStartFailure(input.startError);
  }
  if (input.runId === null) {
    return { kind: "idle" };
  }
  if (input.finishedStatus !== null) {
    return RUN_FAILED_STATUSES.has(input.finishedStatus)
      ? { kind: "failed", message: `The run finished as ${input.finishedStatus}` }
      : { kind: "finished" };
  }
  if (input.historyPending) {
    return { kind: "connecting", detail: "Loading the event log" };
  }
  if (input.historyError !== null && input.historyError !== undefined) {
    return describeHistoryFailure(input.historyError);
  }
  switch (input.socketStatus) {
    case "live":
      return { kind: "streaming" };
    case "reconnecting":
      return {
        kind: "reconnecting",
        attempt: input.socketAttempt,
        detail: input.socketMessage ?? "The connection was lost",
      };
    case "resyncing":
      return { kind: "resyncing" };
    case "failed":
      return { kind: "failed", message: input.socketMessage ?? "The stream failed" };
    case "closed":
    case "idle":
    case "connecting":
    case null:
      return { kind: "connecting", detail: "Connecting to the stream" };
  }
}

export function phaseLiveState(phase: HelloPhase, socketStatus: RunSocketStatus | null): LiveState {
  switch (phase.kind) {
    case "streaming":
      return "live";
    case "starting":
    case "connecting":
    case "reconnecting":
    case "resyncing":
      return socketStatus === null ? "reconnecting" : toLiveState(socketStatus);
    case "failed":
    case "unavailable":
      return "error";
    case "idle":
    case "finished":
      return "closed";
  }
}

export function phaseTitle(phase: HelloPhase): string {
  switch (phase.kind) {
    case "idle":
      return "No run yet";
    case "starting":
      return "Starting the run";
    case "connecting":
      return "Connecting";
    case "streaming":
      return "Streaming";
    case "reconnecting":
      return "Reconnecting";
    case "resyncing":
      return "Resyncing";
    case "finished":
      return "Finished";
    case "failed":
      return "Failed";
    case "unavailable":
      return "Cannot start the run";
  }
}
