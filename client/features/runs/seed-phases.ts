import type { KnownStreamEvent } from "@/features/streams/events";
import type { SeedPhase, SeedPhaseStatus } from "@/lib/api/types";

export const SEED_PHASE_ORDER = ["reset", "hash", "assert"] as const satisfies readonly SeedPhase[];

export type SeedPhaseState = SeedPhaseStatus | "pending" | "not_run";

export interface SeedPhaseView {
  phase: SeedPhase;
  state: SeedPhaseState;
  observedHash: string | null;
  expectedHash: string | null;
}

export interface SeedRunSummary {
  phases: SeedPhaseView[];
  observedHash: string | null;
  expectedHash: string | null;
  failedPhase: SeedPhase | null;
  failureReason: string | null;
  lastEvent: { phase: SeedPhase; status: SeedPhaseStatus } | null;
}

interface PhaseRecord {
  status: SeedPhaseStatus;
  observedHash: string | null;
  expectedHash: string | null;
}

export function summarizeSeedRun(
  events: readonly KnownStreamEvent[],
  runTerminal: boolean,
): SeedRunSummary {
  const seen = new Map<SeedPhase, PhaseRecord>();
  let observedHash: string | null = null;
  let expectedHash: string | null = null;
  let failureReason: string | null = null;
  let lastEvent: SeedRunSummary["lastEvent"] = null;

  for (const event of events) {
    if (event.type === "seed.progress") {
      const { phase, status, observed_hash, expected_hash } = event.payload;
      seen.set(phase, { status, observedHash: observed_hash, expectedHash: expected_hash });
      observedHash = observed_hash ?? observedHash;
      expectedHash = expected_hash ?? expectedHash;
      lastEvent = { phase, status };
    } else if (event.type === "run.status_changed" && event.payload.status === "failed") {
      failureReason = event.payload.reason ?? failureReason;
    }
  }

  const furthest = SEED_PHASE_ORDER.findLastIndex((phase) => seen.has(phase));
  const phases = SEED_PHASE_ORDER.map((phase, index): SeedPhaseView => {
    const record = seen.get(phase);
    if (record !== undefined) {
      return {
        phase,
        state: record.status,
        observedHash: record.observedHash,
        expectedHash: record.expectedHash,
      };
    }
    return {
      phase,
      state: index < furthest || runTerminal ? "not_run" : "pending",
      observedHash: null,
      expectedHash: null,
    };
  });

  const failed = phases.find((view) => view.state === "failed");
  return {
    phases,
    observedHash,
    expectedHash,
    failedPhase: failed?.phase ?? null,
    failureReason,
    lastEvent,
  };
}
