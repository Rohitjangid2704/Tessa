import { useSyncExternalStore } from "react";

interface Clock {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => number;
}

const clocks = new Map<number, Clock>();

function createClock(intervalMs: number): Clock {
  let now = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<() => void>();

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      if (timer === null) {
        now = Date.now();
        timer = setInterval(() => {
          now = Date.now();
          for (const notify of [...listeners]) {
            notify();
          }
        }, intervalMs);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    getSnapshot: () => now,
  };
}

function clockFor(intervalMs: number): Clock {
  const existing = clocks.get(intervalMs);
  if (existing !== undefined) {
    return existing;
  }
  const created = createClock(intervalMs);
  clocks.set(intervalMs, created);
  return created;
}

const readNothing = (): null => null;

export function useNow(intervalMs: number = 1000): number | null {
  const clock = clockFor(intervalMs);
  return useSyncExternalStore<number | null>(clock.subscribe, clock.getSnapshot, readNothing);
}
