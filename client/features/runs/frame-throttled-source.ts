export interface SnapshotSource<Snapshot> {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => Snapshot;
}

export type FrameScheduler = (callback: () => void) => () => void;

const FALLBACK_FRAME_MS = 16;

export const scheduleAnimationFrame: FrameScheduler = (callback) => {
  if (typeof requestAnimationFrame === "function") {
    const handle = requestAnimationFrame(() => callback());
    return () => cancelAnimationFrame(handle);
  }
  const handle = setTimeout(callback, FALLBACK_FRAME_MS);
  return () => clearTimeout(handle);
};

export function createFrameThrottledSource<Snapshot>(
  source: SnapshotSource<Snapshot>,
  schedule: FrameScheduler = scheduleAnimationFrame,
): SnapshotSource<Snapshot> {
  let cached = source.getSnapshot();
  let detach: (() => void) | null = null;
  let cancelFrame: (() => void) | null = null;
  const listeners = new Set<() => void>();

  function flush(): void {
    cancelFrame = null;
    const latest = source.getSnapshot();
    if (Object.is(latest, cached)) {
      return;
    }
    cached = latest;
    for (const listener of [...listeners]) {
      listener();
    }
  }

  function handleSourceChange(): void {
    if (cancelFrame === null) {
      cancelFrame = schedule(flush);
    }
  }

  function release(): void {
    detach?.();
    detach = null;
    cancelFrame?.();
    cancelFrame = null;
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      if (detach === null) {
        cached = source.getSnapshot();
        detach = source.subscribe(handleSourceChange);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          release();
        }
      };
    },
    getSnapshot: () => cached,
  };
}
