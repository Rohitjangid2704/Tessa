import type { EventEnvelope } from "../types";
import type { CoverageUpdateReason, ScenarioStatus } from "@/lib/api/types";

export interface CoverageBusMessage {
  targetId: string;
  envelope: EventEnvelope;
}

export type CoverageBusListener = (message: CoverageBusMessage) => void;

class CoverageBus {
  private readonly listeners = new Set<CoverageBusListener>();

  subscribe(listener: CoverageBusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(targetId: string, type: string, payload: object): void {
    const envelope: EventEnvelope = {
      type,
      run_id: null,
      seq: null,
      ts: new Date().toISOString(),
      payload,
    };
    for (const listener of [...this.listeners]) {
      listener({ targetId, envelope });
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

export const coverageBus = new CoverageBus();

export interface CoverageUpdate {
  targetId: string;
  planId: string | null;
  cellIds: readonly string[];
  reason: CoverageUpdateReason;
}

export function publishCoverageUpdated(update: CoverageUpdate): void {
  coverageBus.publish(update.targetId, "coverage.updated", {
    target_id: update.targetId,
    plan_id: update.planId,
    cell_ids: [...update.cellIds],
    reason: update.reason,
  });
}

export interface ScenarioChange {
  targetId: string;
  scenarioId: string;
  cellId: string | null;
  status: ScenarioStatus;
}

export function publishScenarioChanged(change: ScenarioChange): void {
  coverageBus.publish(change.targetId, "scenario.changed", {
    scenario_id: change.scenarioId,
    status: change.status,
    cell_id: change.cellId,
  });
}
