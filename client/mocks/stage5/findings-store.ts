import type { Finding, FindingChange, FindingStatus, Severity } from "@/lib/api/types";
import type { EventEnvelope } from "../types";
import {
  buildFindingSeed,
  buildLiveFinding,
  type FindingsSeed,
  type SeededFinding,
} from "./findings-seed";
import { FindingsScript } from "./findings-script";

export type { FindingsSeed } from "./findings-seed";

export interface FindingRecord {
  finding: Finding;
  runIds: string[];
}

export interface FindingPatch {
  status?: FindingStatus;
  severity?: Severity;
  ticket_url?: string | null;
  known_gap_reason?: string | null;
}

export type FindingChanges = Record<string, FindingChange>;

export interface FindingUpdateResult {
  finding: Finding;
  changes: FindingChanges;
}

export type FindingFeedListener = (event: EventEnvelope) => void;

export interface FindingsFeedConfig {
  createIntervalMs: number;
  moveIntervalMs: number;
  occurrenceIntervalMs: number;
  paused: boolean;
}

export const DEFAULT_FEED_CONFIG: Readonly<FindingsFeedConfig> = {
  createIntervalMs: 10_000,
  moveIntervalMs: 7000,
  occurrenceIntervalMs: 13_000,
  paused: false,
};

const PATCH_FIELDS = ["status", "severity", "ticket_url", "known_gap_reason"] as const;

export class FindingsStore {
  feed: FindingsFeedConfig = { ...DEFAULT_FEED_CONFIG };
  readonly script = new FindingsScript(this);
  private readonly entries = new Map<string, FindingRecord>();
  private readonly listeners = new Set<FindingFeedListener>();
  private readonly teardown: Array<() => void> = [];
  private seedName: FindingsSeed = "default";
  private seeded = false;
  private sequence = 0;
  private liveCounter = 0;

  get currentSeed(): FindingsSeed {
    return this.seedName;
  }

  onReset(callback: () => void): void {
    this.teardown.push(callback);
  }

  reset(seed: FindingsSeed = "default"): void {
    for (const callback of this.teardown) {
      callback();
    }
    this.entries.clear();
    this.seedName = seed;
    this.seeded = false;
    this.sequence = 0;
    this.liveCounter = 0;
    this.feed = { ...DEFAULT_FEED_CONFIG };
    this.script.reset();
  }

  ensure(): void {
    if (this.seeded) {
      return;
    }
    this.seeded = true;
    for (const seeded of buildFindingSeed(this.seedName)) {
      this.entries.set(seeded.finding.id, { finding: seeded.finding, runIds: seeded.runIds });
    }
  }

  get records(): FindingRecord[] {
    this.ensure();
    return [...this.entries.values()];
  }

  get all(): Finding[] {
    return this.records.map((record) => record.finding);
  }

  findRecord(id: string): FindingRecord | undefined {
    this.ensure();
    return this.entries.get(id);
  }

  find(id: string): Finding | undefined {
    return this.findRecord(id)?.finding;
  }

  countsByStatus(): Record<FindingStatus, number> {
    const counts: Record<FindingStatus, number> = {
      new: 0,
      triaged: 0,
      in_fix: 0,
      verifying: 0,
      resolved: 0,
      known_gap: 0,
      dismissed: 0,
    };
    for (const record of this.records) {
      counts[record.finding.status] += 1;
    }
    return counts;
  }

  subscribe(listener: FindingFeedListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private emit(
    type: string,
    payload: object,
    options: { runId?: string | null; seq?: number | null } = {},
  ): void {
    const event: EventEnvelope = {
      type,
      run_id: options.runId ?? null,
      seq: options.seq ?? null,
      ts: new Date().toISOString(),
      payload,
    };
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  replace(finding: Finding): Finding {
    const record = this.findRecord(finding.id);
    if (record === undefined) {
      throw new Error(`no finding ${finding.id}`);
    }
    record.finding = finding;
    return finding;
  }

  update(id: string, patch: FindingPatch): FindingUpdateResult {
    const record = this.findRecord(id);
    if (record === undefined) {
      throw new Error(`no finding ${id}`);
    }
    const previous = record.finding;
    const next: Finding = { ...previous };
    const changes: FindingChanges = {};
    for (const field of PATCH_FIELDS) {
      if (!(field in patch)) {
        continue;
      }
      const incoming: unknown = patch[field];
      const current: unknown = previous[field];
      if (incoming === undefined || incoming === current) {
        continue;
      }
      Reflect.set(next, field, incoming);
      changes[field] = { from: current, to: incoming };
    }
    record.finding = next;
    if (Object.keys(changes).length > 0) {
      this.emit("finding.updated", { finding_id: id, changes });
    }
    return { finding: next, changes };
  }

  recordOccurrence(
    id: string,
    runId: string,
    seenAtMs: number = Date.now(),
  ): Finding | undefined {
    const record = this.findRecord(id);
    if (record === undefined) {
      return undefined;
    }
    const finding: Finding = {
      ...record.finding,
      occurrence_count: record.finding.occurrence_count + 1,
      last_seen_at: new Date(seenAtMs).toISOString(),
      last_seen_run_id: runId,
    };
    record.finding = finding;
    if (!record.runIds.includes(runId)) {
      record.runIds.push(runId);
    }
    this.emit("finding.occurrence_added", {
      finding_id: id,
      run_id: runId,
      occurrence_count: finding.occurrence_count,
    });
    return finding;
  }

  add(seeded: SeededFinding): Finding {
    this.ensure();
    const { finding } = seeded;
    this.entries.set(finding.id, { finding, runIds: [...seeded.runIds] });
    this.emit(
      "finding.created",
      {
        finding_id: finding.id,
        title: finding.title,
        class: finding.class,
        severity: finding.severity,
        status: finding.status,
        fingerprint: finding.fingerprint,
        is_new: true,
        scenario_id: finding.scenario_id,
      },
      { runId: finding.last_seen_run_id, seq: this.nextSequence() },
    );
    return finding;
  }

  createLive(nowMs: number = Date.now()): Finding {
    this.ensure();
    this.liveCounter += 1;
    return this.add(buildLiveFinding(this.liveCounter, nowMs));
  }
}
