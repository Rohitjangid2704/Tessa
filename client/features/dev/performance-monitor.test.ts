import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PerformanceMonitor } from "./performance-monitor";

const MEGABYTE = 1024 * 1024;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function createMonitor(options: { heap?: () => number | null; observer?: boolean } = {}) {
  let clock = 0;
  let reportDurations: (durations: number[]) => void = () => {};
  const disconnect = vi.fn();
  const monitor = new PerformanceMonitor({
    now: () => clock,
    readHeapBytes: options.heap ?? (() => 100 * MEGABYTE),
    createObserver:
      options.observer === false
        ? () => null
        : (callback) => {
            reportDurations = callback;
            return { disconnect };
          },
    sampleIntervalMs: 500,
  });
  return {
    monitor,
    disconnect,
    advance: (ms: number) => {
      clock += ms;
    },
    report: (durations: number[]) => reportDurations(durations),
  };
}

describe("PerformanceMonitor", () => {
  it("counts only tasks over 50 ms and derives a per-minute rate", async () => {
    const { monitor, advance, report } = createMonitor();
    monitor.start();
    report([49, 51, 120, 30]);
    advance(30_000);
    await vi.advanceTimersByTimeAsync(500);

    const snapshot = monitor.getState();
    expect(snapshot.longTaskCount).toBe(2);
    expect(snapshot.longestTaskMs).toBe(120);
    expect(snapshot.longTasksPerMinute).toBeCloseTo(4, 5);
    expect(snapshot.elapsedMs).toBe(30_000);
  });

  it("reports heap growth against the baseline taken at start", async () => {
    let heap = 100 * MEGABYTE;
    const { monitor, advance } = createMonitor({ heap: () => heap });
    monitor.start();
    heap = 112 * MEGABYTE;
    advance(10_000);
    await vi.advanceTimersByTimeAsync(500);
    heap = 108 * MEGABYTE;
    await vi.advanceTimersByTimeAsync(500);

    const snapshot = monitor.getState();
    expect(snapshot.heapSupported).toBe(true);
    expect(snapshot.heapBaselineMb).toBe(100);
    expect(snapshot.heapUsedMb).toBe(108);
    expect(snapshot.heapGrowthMb).toBe(8);
    expect(snapshot.heapPeakMb).toBe(112);
  });

  it("says the heap is unsupported where performance.memory does not exist", () => {
    const { monitor } = createMonitor({ heap: () => null });
    monitor.start();

    expect(monitor.getState()).toMatchObject({ heapSupported: false, heapGrowthMb: 0 });
  });

  it("works without a long task observer", async () => {
    const { monitor } = createMonitor({ observer: false });
    monitor.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(monitor.getState().longTaskCount).toBe(0);
    monitor.stop();
  });

  it("resets the window", async () => {
    const { monitor, advance, report } = createMonitor();
    monitor.start();
    report([100]);
    advance(5000);
    monitor.reset();

    expect(monitor.getState()).toMatchObject({ longTaskCount: 0, elapsedMs: 0 });
  });

  it("stop() disconnects the observer and clears the timer, and start is idempotent", () => {
    const { monitor, disconnect } = createMonitor();
    monitor.start();
    monitor.start();
    expect(vi.getTimerCount()).toBe(1);

    monitor.stop();
    monitor.stop();

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("notifies subscribers on every sample", async () => {
    const { monitor } = createMonitor();
    const listener = vi.fn();
    monitor.subscribe(listener);
    monitor.start();
    const afterStart = listener.mock.calls.length;

    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);

    expect(listener.mock.calls.length).toBe(afterStart + 2);
  });
});
