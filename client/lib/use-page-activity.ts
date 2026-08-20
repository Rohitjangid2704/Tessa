import { useState, useSyncExternalStore } from "react";

export interface VisibilityTarget {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener: (type: "visibilitychange", listener: () => void) => void;
  removeEventListener: (type: "visibilitychange", listener: () => void) => void;
}

export interface ActivityGate {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => boolean;
}

export const HIDDEN_PAGE_GRACE_MS = 60_000;

export function createActivityGate(graceMs: number, target?: VisibilityTarget): ActivityGate {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();

  const resolveTarget = (): VisibilityTarget => target ?? document;

  function setActive(next: boolean): void {
    if (active === next) {
      return;
    }
    active = next;
    for (const listener of [...listeners]) {
      listener();
    }
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function sync(): void {
    if (resolveTarget().visibilityState === "visible") {
      clearTimer();
      setActive(true);
      return;
    }
    if (active && timer === null) {
      timer = setTimeout(() => {
        timer = null;
        setActive(false);
      }, graceMs);
    }
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        resolveTarget().addEventListener("visibilitychange", sync);
        sync();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          resolveTarget().removeEventListener("visibilitychange", sync);
          clearTimer();
        }
      };
    },
    getSnapshot: () => active,
  };
}

const readServerActivity = (): boolean => true;

export function usePageActivity(graceMs: number = HIDDEN_PAGE_GRACE_MS): boolean {
  const [gate] = useState(() => createActivityGate(graceMs));
  return useSyncExternalStore(gate.subscribe, gate.getSnapshot, readServerActivity);
}
