import type { KnownStreamEvent } from "@/features/streams/events";
import { KeyedTrailingThrottle } from "@/lib/keyed-throttle";
import { createStore, type Store } from "@/lib/store";
import type { RunEventsPage } from "./run-event-pages";

export const STREAM_EVENT_LIMIT = 200;
export const INVALIDATION_THROTTLE_MS = 1000;
export const STATS_INVALIDATION_THROTTLE_MS = 5000;

export type PersistedRunEvent = KnownStreamEvent & { seq: number };

export interface SeqGap {
  expected: number;
  received: number;
}

export interface RunEventsSnapshot {
  events: readonly KnownStreamEvent[];
  streamEvents: readonly KnownStreamEvent[];
  loaded: boolean;
  finished: boolean;
  lastSeq: number;
  lowestSeq: number | null;
  hasOlder: boolean;
  loadingOlder: boolean;
  olderError: Error | null;
  skippedCount: number;
  gap: SeqGap | null;
}

export interface RunEventFeed {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => RunEventsSnapshot;
  loadOlder: (beforeSeq?: number) => Promise<void>;
}

export type AppendOutcome =
  | { outcome: "applied" }
  | { outcome: "duplicate" }
  | { outcome: "gap"; expected: number; received: number };

export interface LoadOptions {
  runTerminal?: boolean;
}

export interface RunEventStoreOptions {
  fetchPage?: (beforeSeq: number) => Promise<RunEventsPage>;
  throttleMs?: number;
  statsThrottleMs?: number;
  streamEventLimit?: number;
}

function createInitialSnapshot(): RunEventsSnapshot {
  return {
    events: [],
    streamEvents: [],
    loaded: false,
    finished: false,
    lastSeq: 0,
    lowestSeq: null,
    hasOlder: false,
    loadingOlder: false,
    olderError: null,
    skippedCount: 0,
    gap: null,
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Could not load older events");
}

function isRunFinished(event: KnownStreamEvent): boolean {
  return event.type === "run.finished";
}

export class RunEventStore implements RunEventFeed {
  readonly runId: string;
  private readonly store: Store<RunEventsSnapshot> = createStore(createInitialSnapshot());
  private readonly fetchPage: ((beforeSeq: number) => Promise<RunEventsPage>) | undefined;
  private readonly throttle: KeyedTrailingThrottle;
  private readonly statsThrottle: KeyedTrailingThrottle;
  private readonly streamEventLimit: number;
  private epoch = 0;

  constructor(runId: string, options: RunEventStoreOptions = {}) {
    this.runId = runId;
    this.fetchPage = options.fetchPage;
    this.throttle = new KeyedTrailingThrottle(options.throttleMs ?? INVALIDATION_THROTTLE_MS);
    this.statsThrottle = new KeyedTrailingThrottle(
      options.statsThrottleMs ?? STATS_INVALIDATION_THROTTLE_MS,
    );
    this.streamEventLimit = options.streamEventLimit ?? STREAM_EVENT_LIMIT;
  }

  readonly subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);

  readonly getSnapshot = (): RunEventsSnapshot => this.store.getState();

  getLastSeq(): number {
    return this.store.getState().lastSeq;
  }

  load(page: RunEventsPage, options: LoadOptions = {}): void {
    this.epoch += 1;
    const previous = this.store.getState();
    this.store.setState({
      events: page.events,
      streamEvents: previous.streamEvents,
      loaded: true,
      finished: options.runTerminal === true || page.events.some(isRunFinished),
      lastSeq: page.highestSeq,
      lowestSeq: page.lowestSeq,
      hasOlder: page.hasMore,
      loadingOlder: false,
      olderError: null,
      skippedCount: page.skipped,
      gap: null,
    });
  }

  append(event: PersistedRunEvent): AppendOutcome {
    const state = this.store.getState();
    const rejected = this.judge(state.lastSeq, event.seq);
    if (rejected !== null) {
      return rejected;
    }
    this.store.setState({
      ...state,
      events: [...state.events, event],
      lastSeq: event.seq,
      lowestSeq: state.lowestSeq ?? event.seq,
      finished: state.finished || isRunFinished(event),
      gap: null,
    });
    return { outcome: "applied" };
  }

  skip(seq: number): AppendOutcome {
    const state = this.store.getState();
    const rejected = this.judge(state.lastSeq, seq);
    if (rejected !== null) {
      return rejected;
    }
    this.store.setState({
      ...state,
      lastSeq: seq,
      skippedCount: state.skippedCount + 1,
      gap: null,
    });
    return { outcome: "applied" };
  }

  recordStreamEvent(event: KnownStreamEvent): void {
    const state = this.store.getState();
    this.store.setState({
      ...state,
      streamEvents: [...state.streamEvents, event].slice(-this.streamEventLimit),
    });
  }

  clearGap(): void {
    const state = this.store.getState();
    if (state.gap !== null) {
      this.store.setState({ ...state, gap: null });
    }
  }

  async loadOlder(beforeSeq?: number): Promise<void> {
    const state = this.store.getState();
    const cursor = beforeSeq ?? state.lowestSeq;
    if (this.fetchPage === undefined || cursor === null || state.loadingOlder || !state.hasOlder) {
      return;
    }
    const epoch = this.epoch;
    this.store.setState({ ...state, loadingOlder: true, olderError: null });
    try {
      const page = await this.fetchPage(cursor);
      if (epoch === this.epoch) {
        this.mergeOlder(page, cursor);
      }
    } catch (error) {
      if (epoch === this.epoch) {
        this.store.setState({
          ...this.store.getState(),
          loadingOlder: false,
          olderError: toError(error),
        });
      }
    }
  }

  scheduleInvalidation(key: string, task: () => void): void {
    this.throttle.schedule(key, task);
  }

  scheduleStatsInvalidation(key: string, task: () => void): void {
    this.statsThrottle.schedule(key, task);
  }

  flushScheduled(): void {
    this.throttle.flush();
    this.statsThrottle.flush();
  }

  dispose(): void {
    this.throttle.cancel();
    this.statsThrottle.cancel();
  }

  private judge(lastSeq: number, seq: number): AppendOutcome | null {
    if (seq <= lastSeq) {
      return { outcome: "duplicate" };
    }
    const expected = lastSeq + 1;
    if (seq === expected) {
      return null;
    }
    this.store.setState({ ...this.store.getState(), gap: { expected, received: seq } });
    return { outcome: "gap", expected, received: seq };
  }

  private mergeOlder(page: RunEventsPage, cursor: number): void {
    const state = this.store.getState();
    const known = new Set(state.events.map((event) => event.seq));
    const older = page.events.filter(
      (event) => event.seq !== null && event.seq < cursor && !known.has(event.seq),
    );
    this.store.setState({
      ...state,
      events: [...older, ...state.events],
      lowestSeq: page.lowestSeq ?? state.lowestSeq,
      hasOlder: page.hasMore,
      loadingOlder: false,
      olderError: null,
      skippedCount: state.skippedCount + page.skipped,
    });
  }
}
