import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNow } from "./use-now";

const START = new Date("2026-10-01T10:00:00.000Z").getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useNow", () => {
  it("returns the current time and ticks on the interval", () => {
    const { result } = renderHook(() => useNow(1000));
    expect(result.current).toBe(START);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(START + 1000);

    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(result.current).toBe(START + 3000);
  });

  it("shares one timer between components with the same interval", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const first = renderHook(() => useNow(5000));
    const second = renderHook(() => useNow(5000));
    const calls = setIntervalSpy.mock.calls.filter(([, delay]) => delay === 5000);

    expect(calls).toHaveLength(1);
    first.unmount();
    second.unmount();
    setIntervalSpy.mockRestore();
  });

  it("stops the timer when the last subscriber unmounts and restarts with a fresh time", () => {
    const first = renderHook(() => useNow(2000));
    first.unmount();
    expect(vi.getTimerCount()).toBe(0);

    vi.setSystemTime(START + 60_000);
    const second = renderHook(() => useNow(2000));

    expect(second.result.current).toBe(START + 60_000);
    second.unmount();
  });

  it("works under StrictMode", () => {
    const { result } = renderHook(() => useNow(1000), { wrapper: StrictMode });
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(result.current).toBe(START + 1000);
  });

  it("is null while rendering on the server", () => {
    let seen: number | null | undefined;
    function Probe() {
      seen = useNow(1000);
      return null;
    }
    renderToString(<Probe />);

    expect(seen).toBeNull();
  });
});
