import { useSyncExternalStore } from "react";
import type { PaintedFrame } from "@/lib/ws/frame-bus";

export const ACTIVITY_RESOLUTION_MS = 500;

export interface TileActivity {
  lastFrameAt: number;
  frameSeq: number;
  pageUrl: string | null;
}

export class TileActivityStore {
  private readonly entries = new Map<string, TileActivity>();
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly get = (sessionId: string): TileActivity | undefined => this.entries.get(sessionId);

  record(sessionId: string, frame: PaintedFrame, now: number): void {
    const previous = this.entries.get(sessionId);
    const pageUrl = frame.pageUrl ?? previous?.pageUrl ?? null;
    if (
      previous !== undefined &&
      previous.pageUrl === pageUrl &&
      now - previous.lastFrameAt < ACTIVITY_RESOLUTION_MS
    ) {
      return;
    }
    this.entries.set(sessionId, { lastFrameAt: now, frameSeq: frame.frameSeq, pageUrl });
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

export function useTileActivity(
  store: TileActivityStore,
  sessionId: string,
): TileActivity | undefined {
  return useSyncExternalStore(
    store.subscribe,
    () => store.get(sessionId),
    () => undefined,
  );
}
