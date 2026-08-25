import type { ReplayRecord } from "@/lib/api/types";

export interface ReplayEntry {
  replayId: string;
  runId: string;
  targetId: string;
  sourceName: string;
  createdAt: string;
  records: ReplayRecord[];
  outcomes: ReplayRecord[];
  scenarioStatuses: ReadonlyMap<string, "in_review" | "accepted">;
}

export class ReplayStore {
  private readonly rows: ReplayEntry[] = [];

  get entries(): readonly ReplayEntry[] {
    return this.rows;
  }

  reset(): void {
    this.rows.length = 0;
  }

  add(entry: ReplayEntry): void {
    this.rows.push(entry);
  }

  find(replayId: string): ReplayEntry | undefined {
    return this.rows.find((entry) => entry.replayId === replayId);
  }

  findByRun(runId: string): ReplayEntry | undefined {
    return this.rows.find((entry) => entry.runId === runId);
  }
}

export const replayStore = new ReplayStore();
