import type { Finding, FindingStatus } from "@/lib/api/types";
import { STAGE_TWO_IDS } from "../stage2/seed-ids";
import type { FindingsStore } from "./findings-store";

export const SCRIPT_ACTIONS = ["created", "moved", "occurrence"] as const;

export type ScriptAction = (typeof SCRIPT_ACTIONS)[number];

interface SystemMove {
  from: FindingStatus;
  to: FindingStatus;
  withOccurrence: boolean;
}

const MOVES: readonly SystemMove[] = [
  { from: "verifying", to: "resolved", withOccurrence: false },
  { from: "new", to: "triaged", withOccurrence: false },
  { from: "resolved", to: "new", withOccurrence: true },
  { from: "in_fix", to: "verifying", withOccurrence: false },
  { from: "verifying", to: "in_fix", withOccurrence: true },
  { from: "triaged", to: "in_fix", withOccurrence: false },
];

const OCCURRENCE_STATUSES: readonly FindingStatus[] = ["new", "triaged", "known_gap", "dismissed"];

const OCCURRENCE_RUN_ID = STAGE_TWO_IDS.runs.showcase;

export class FindingsScript {
  private readonly store: FindingsStore;
  private moveCursor = 0;
  private occurrenceCursor = 0;

  constructor(store: FindingsStore) {
    this.store = store;
  }

  reset(): void {
    this.moveCursor = 0;
    this.occurrenceCursor = 0;
  }

  create(): Finding {
    return this.store.createLive();
  }

  move(): Finding | null {
    for (let attempt = 0; attempt < MOVES.length; attempt += 1) {
      const step = MOVES[(this.moveCursor + attempt) % MOVES.length];
      const candidates = this.store.all.filter((finding) => finding.status === step?.from);
      const picked = candidates[this.moveCursor % Math.max(candidates.length, 1)];
      if (step === undefined || picked === undefined) {
        continue;
      }
      this.moveCursor += attempt + 1;
      if (step.withOccurrence) {
        this.store.recordOccurrence(picked.id, OCCURRENCE_RUN_ID);
      }
      return this.store.update(picked.id, { status: step.to }).finding;
    }
    return null;
  }

  occurrence(): Finding | null {
    const candidates = this.store.all.filter((finding) =>
      OCCURRENCE_STATUSES.includes(finding.status),
    );
    const picked = candidates[this.occurrenceCursor % Math.max(candidates.length, 1)];
    if (picked === undefined) {
      return null;
    }
    this.occurrenceCursor += 1;
    return this.store.recordOccurrence(picked.id, OCCURRENCE_RUN_ID) ?? null;
  }

  run(action: ScriptAction): Finding | null {
    if (action === "created") {
      return this.create();
    }
    return action === "moved" ? this.move() : this.occurrence();
  }
}
