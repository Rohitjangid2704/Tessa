import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyedTrailingThrottle } from "./keyed-throttle";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("KeyedTrailingThrottle", () => {
  it("runs a burst for one key once, at the end of the window", () => {
    const throttle = new KeyedTrailingThrottle(1000);
    const task = vi.fn();

    throttle.schedule("scenarios", task);
    vi.advanceTimersByTime(400);
    throttle.schedule("scenarios", task);
    vi.advanceTimersByTime(400);
    throttle.schedule("scenarios", task);
    expect(task).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(task).toHaveBeenCalledTimes(1);
    expect(throttle.pendingCount).toBe(0);
  });

  it("starts a new window for an event after the task ran", () => {
    const throttle = new KeyedTrailingThrottle(1000);
    const task = vi.fn();

    throttle.schedule("scenarios", task);
    vi.advanceTimersByTime(1000);
    throttle.schedule("scenarios", task);
    vi.advanceTimersByTime(999);
    expect(task).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("keeps separate windows per key", () => {
    const throttle = new KeyedTrailingThrottle(1000);
    const first = vi.fn();
    const second = vi.fn();

    throttle.schedule("a", first);
    vi.advanceTimersByTime(500);
    throttle.schedule("b", second);
    vi.advanceTimersByTime(500);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("flushes every pending task at once and cancels the timers", () => {
    const throttle = new KeyedTrailingThrottle(1000);
    const first = vi.fn();
    const second = vi.fn();
    throttle.schedule("a", first);
    throttle.schedule("b", second);

    throttle.flush();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(throttle.pendingCount).toBe(0);
  });

  it("drops pending tasks on cancel and stays usable", () => {
    const throttle = new KeyedTrailingThrottle(1000);
    const task = vi.fn();
    throttle.schedule("a", task);

    throttle.cancel();
    vi.advanceTimersByTime(5000);
    expect(task).not.toHaveBeenCalled();

    throttle.schedule("a", task);
    vi.advanceTimersByTime(1000);
    expect(task).toHaveBeenCalledTimes(1);
  });
});
