import {
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_SECONDS,
  resolveMockConfig,
  type MockConfig,
} from "./config";
import { createSeedUsers } from "./factories/users";
import { FaultRegistry } from "./server/faults";
import { StageOneStore } from "./stage1/store";
import { StageTwoStore } from "./stage2/store";
import { StageThreeStore } from "./stage3/store";
import { StageFourStore } from "./stage4/store";
import { StageFiveStore } from "./stage5/store";
import type { FrameSession, FrameStreamer } from "./server/frames";
import type { MockUser, PayloadOf, PersistedEventType, RunEvent } from "./types";

export type RunEventListener = (event: RunEvent) => void;

export interface RunRecord {
  id: string;
  createdBy: string;
  events: RunEvent[];
  finished: boolean;
  timers: Array<ReturnType<typeof setTimeout>>;
  frameSessions?: FrameSession[];
  framePoolSize?: number;
}

export interface StoredIdempotentResponse {
  requestHash: string;
  status: number;
  body: unknown;
}

export interface ConnectionCounters {
  opened: number;
  open: number;
  ticketsIssued: number;
}

const MILLISECONDS_PER_SECOND = 1000;

export class MockState {
  config: MockConfig = resolveMockConfig();
  readonly faults = new FaultRegistry();
  readonly runs = new Map<string, RunRecord>();
  readonly idempotency = new Map<string, StoredIdempotentResponse>();
  readonly usedTicketIds = new Set<string>();
  readonly connections: ConnectionCounters = { opened: 0, open: 0, ticketsIssued: 0 };
  readonly frameStreamers = new Set<FrameStreamer>();
  readonly stageOne = new StageOneStore();
  readonly stageThree = new StageThreeStore();
  readonly stageFour = new StageFourStore();
  readonly stageFive = new StageFiveStore();
  users: MockUser[] = createSeedUsers();
  private readonly loginFailures = new Map<string, number[]>();
  private readonly listeners = new Map<string, Set<RunEventListener>>();
  private readonly globalListeners = new Set<RunEventListener>();
  readonly stageTwo = new StageTwoStore(this);

  configure(overrides: Partial<MockConfig>): void {
    this.config = { ...this.config, ...overrides };
  }

  restoreConfig(): void {
    this.config = resolveMockConfig();
  }

  reset(): void {
    for (const run of this.runs.values()) {
      for (const timer of run.timers) {
        clearTimeout(timer);
      }
    }
    for (const streamer of this.frameStreamers) {
      streamer.stop();
    }
    this.frameStreamers.clear();
    this.runs.clear();
    this.idempotency.clear();
    this.usedTicketIds.clear();
    this.loginFailures.clear();
    this.faults.reset();
    this.users = createSeedUsers();
    this.stageOne.reset();
    this.stageTwo.reset();
    this.stageThree.reset();
    this.stageFour.reset();
    this.stageFive.reset();
    this.connections.ticketsIssued = 0;
    this.connections.opened = 0;
  }

  findUserByEmail(email: string): MockUser | undefined {
    const normalized = email.trim().toLowerCase();
    return this.users.find((user) => user.email.toLowerCase() === normalized);
  }

  findUserById(id: string): MockUser | undefined {
    return this.users.find((user) => user.id === id);
  }

  loginRetryAfterSeconds(key: string): number | null {
    const recent = this.recentLoginFailures(key);
    const oldest = recent[0];
    if (recent.length < LOGIN_MAX_FAILURES || oldest === undefined) {
      return null;
    }
    const remainingMs = oldest + LOGIN_WINDOW_SECONDS * MILLISECONDS_PER_SECOND - Date.now();
    return Math.max(1, Math.ceil(remainingMs / MILLISECONDS_PER_SECOND));
  }

  recordLoginFailure(key: string): void {
    this.loginFailures.set(key, [...this.recentLoginFailures(key), Date.now()]);
  }

  clearLoginFailures(key: string): void {
    this.loginFailures.delete(key);
  }

  private recentLoginFailures(key: string): number[] {
    const threshold = Date.now() - LOGIN_WINDOW_SECONDS * MILLISECONDS_PER_SECOND;
    return (this.loginFailures.get(key) ?? []).filter((moment) => moment > threshold);
  }

  appendEvent<Type extends PersistedEventType>(
    run: RunRecord,
    type: Type,
    payload: PayloadOf<Type>,
  ): RunEvent {
    return this.appendRawEvent(run, type, payload);
  }

  appendRawEvent(
    run: RunRecord,
    type: string,
    payload: object,
    ts: string = new Date().toISOString(),
  ): RunEvent {
    const event: RunEvent = {
      type,
      run_id: run.id,
      seq: run.events.length + 1,
      ts,
      payload: { ...payload },
    };
    run.events.push(event);
    for (const listener of this.listeners.get(run.id) ?? []) {
      listener(event);
    }
    for (const listener of this.globalListeners) {
      listener(event);
    }
    return event;
  }

  findRun(id: string): RunRecord | undefined {
    return this.runs.get(id) ?? this.stageTwo.findRunRecord(id);
  }

  subscribeAll(listener: RunEventListener): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  subscribe(runId: string, listener: RunEventListener): () => void {
    const registered = this.listeners.get(runId) ?? new Set<RunEventListener>();
    registered.add(listener);
    this.listeners.set(runId, registered);
    return () => {
      registered.delete(listener);
      if (registered.size === 0 && this.listeners.get(runId) === registered) {
        this.listeners.delete(runId);
      }
    };
  }

  schedule(run: RunRecord, delayMs: number, action: () => void): void {
    run.timers.push(setTimeout(action, delayMs));
  }
}

export const mockState = new MockState();
