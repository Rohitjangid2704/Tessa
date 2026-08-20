import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThrottledValue } from "./use-throttled-value";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useThrottledValue", () => {
  it("shows the first value at once", () => {
    const { result } = renderHook(() => useThrottledValue("a", 2000));

    expect(result.current).toBe("a");
  });

  it("shows the first change straight away and then at most one change per interval", () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useThrottledValue(value, 2000),
      { initialProps: { value: "a" } },
    );

    rerender({ value: "b" });
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(result.current).toBe("b");

    rerender({ value: "c" });
    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(result.current).toBe("b");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe("c");
  });

  it("drops intermediate values and settles on the latest one", () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useThrottledValue(value, 2000),
      { initialProps: { value: "a" } },
    );
    rerender({ value: "b" });
    act(() => {
      vi.advanceTimersByTime(0);
    });

    rerender({ value: "c" });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    rerender({ value: "d" });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    rerender({ value: "e" });
    expect(result.current).toBe("b");

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe("e");
  });

  it("does nothing when the value comes back before the timer fires", () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: string }) => useThrottledValue(value, 2000),
      { initialProps: { value: "a" } },
    );
    rerender({ value: "b" });
    act(() => {
      vi.advanceTimersByTime(0);
    });
    rerender({ value: "c" });
    rerender({ value: "b" });

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(result.current).toBe("b");
  });
});
