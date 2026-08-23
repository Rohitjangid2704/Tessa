import { createStore, type ReadableStore } from "@/lib/store";

export const LONG_TASK_THRESHOLD_MS = 50;
export const PERFORMANCE_SAMPLE_INTERVAL_MS = 500;
const BYTES_PER_MEGABYTE = 1024 * 1024;
const MILLISECONDS_PER_MINUTE = 60_000;

export interface PerformanceSnapshot {
  elapsedMs: number;
  longTaskCount: number;
  longTasksPerMinute: number;
  longestTaskMs: number;
  heapSupported: boolean;
  heapUsedMb: number;
  heapBaselineMb: number;
  heapGrowthMb: number;
  heapPeakMb: number;
}

interface ChromiumPerformance extends Performance {
  memory?: { usedJSHeapSize: number };
}

export interface PerformanceMonitorOptions {
  now?: () => number;
  readHeapBytes?: () => number | null;
  createObserver?: (callback: (durationsMs: number[]) => void) => { disconnect: () => void } | null;
  sampleIntervalMs?: number;
}

function defaultReadHeapBytes(): number | null {
  const memory = (performance as ChromiumPerformance).memory;
  return memory === undefined ? null : memory.usedJSHeapSize;
}

function defaultCreateObserver(
  callback: (durationsMs: number[]) => void,
): { disconnect: () => void } | null {
  if (typeof PerformanceObserver === "undefined") {
    return null;
  }
  if (!PerformanceObserver.supportedEntryTypes.includes("longtask")) {
    return null;
  }
  const observer = new PerformanceObserver((list) => {
    callback(list.getEntries().map((entry) => entry.duration));
  });
  observer.observe({ type: "longtask", buffered: true });
  return observer;
}

function createEmptySnapshot(): PerformanceSnapshot {
  return {
    elapsedMs: 0,
    longTaskCount: 0,
    longTasksPerMinute: 0,
    longestTaskMs: 0,
    heapSupported: false,
    heapUsedMb: 0,
    heapBaselineMb: 0,
    heapGrowthMb: 0,
    heapPeakMb: 0,
  };
}

export class PerformanceMonitor implements ReadableStore<PerformanceSnapshot> {
  private readonly options: Required<PerformanceMonitorOptions>;
  private readonly store = createStore<PerformanceSnapshot>(createEmptySnapshot());
  private startedAt = 0;
  private longTasks: number[] = [];
  private heapBaselineBytes: number | null = null;
  private heapPeakBytes = 0;
  private observer: { disconnect: () => void } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: PerformanceMonitorOptions = {}) {
    this.options = {
      now: options.now ?? (() => performance.now()),
      readHeapBytes: options.readHeapBytes ?? defaultReadHeapBytes,
      createObserver: options.createObserver ?? defaultCreateObserver,
      sampleIntervalMs: options.sampleIntervalMs ?? PERFORMANCE_SAMPLE_INTERVAL_MS,
    };
  }

  readonly getState = (): PerformanceSnapshot => this.store.getState();

  readonly subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.reset();
    this.observer = this.options.createObserver((durations) => {
      for (const duration of durations) {
        if (duration > LONG_TASK_THRESHOLD_MS) {
          this.longTasks.push(duration);
        }
      }
    });
    this.timer = setInterval(() => this.sample(), this.options.sampleIntervalMs);
  }

  stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.observer?.disconnect();
    this.observer = null;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  reset(): void {
    this.startedAt = this.options.now();
    this.longTasks = [];
    this.heapBaselineBytes = this.options.readHeapBytes();
    this.heapPeakBytes = this.heapBaselineBytes ?? 0;
    this.sample();
  }

  sample(): void {
    const elapsedMs = Math.max(0, this.options.now() - this.startedAt);
    const heapBytes = this.options.readHeapBytes();
    if (heapBytes !== null) {
      this.heapPeakBytes = Math.max(this.heapPeakBytes, heapBytes);
    }
    const baseline = this.heapBaselineBytes ?? heapBytes ?? 0;
    this.store.setState({
      elapsedMs,
      longTaskCount: this.longTasks.length,
      longTasksPerMinute:
        elapsedMs > 0 ? (this.longTasks.length * MILLISECONDS_PER_MINUTE) / elapsedMs : 0,
      longestTaskMs: this.longTasks.reduce((longest, duration) => Math.max(longest, duration), 0),
      heapSupported: heapBytes !== null,
      heapUsedMb: (heapBytes ?? 0) / BYTES_PER_MEGABYTE,
      heapBaselineMb: baseline / BYTES_PER_MEGABYTE,
      heapGrowthMb: heapBytes === null ? 0 : (heapBytes - baseline) / BYTES_PER_MEGABYTE,
      heapPeakMb: this.heapPeakBytes / BYTES_PER_MEGABYTE,
    });
  }
}
