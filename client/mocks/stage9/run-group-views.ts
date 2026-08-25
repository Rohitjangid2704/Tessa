import { isTerminal } from "../stage2/support";
import type { StageTwoStore } from "../stage2/store";
import type { RunGroup, RunStatus } from "@/lib/api/types";
import type { RunGroupRecord } from "./run-group-store";

const TERMINAL_PRECEDENCE: readonly RunStatus[] = ["failed", "budget_exceeded", "canceled"];

export function deriveRunGroupStatus(statuses: readonly RunStatus[]): RunStatus {
  if (statuses.length === 0) {
    return "queued";
  }
  if (statuses.includes("canceling")) {
    return "canceling";
  }
  if (!statuses.every(isTerminal)) {
    return statuses.every((status) => status === "queued") ? "queued" : "running";
  }
  return TERMINAL_PRECEDENCE.find((status) => statuses.includes(status)) ?? "completed";
}

export function toRunGroup(store: StageTwoStore, record: RunGroupRecord): RunGroup {
  const statuses = record.runIds.flatMap((runId) => {
    const entry = store.findRun(runId);
    return entry === undefined ? [] : [entry.run.status];
  });
  return {
    id: record.id,
    run_ids: [...record.runIds],
    status: deriveRunGroupStatus(statuses),
    created_at: record.createdAt,
  };
}
