import { createStore, useStoreSelector } from "@/lib/store";
import type { StatusMove } from "./detail-schemas";

export interface SystemMoveNotice extends StatusMove {
  at: string;
}

const store = createStore<ReadonlyMap<string, SystemMoveNotice>>(new Map());

export function recordSystemMove(findingId: string, move: StatusMove, at: string): void {
  store.update((previous) => {
    const next = new Map(previous);
    next.set(findingId, { ...move, at });
    return next;
  });
}

export function clearSystemMove(findingId: string): void {
  store.update((previous) => {
    if (!previous.has(findingId)) {
      return previous;
    }
    const next = new Map(previous);
    next.delete(findingId);
    return next;
  });
}

export function useSystemMove(findingId: string): SystemMoveNotice | null {
  return useStoreSelector(store, (state) => state.get(findingId) ?? null);
}
