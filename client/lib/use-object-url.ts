import { useMemo, useSyncExternalStore } from "react";

interface ObjectUrlEntry {
  url: string;
  holders: number;
  revokeTimer: ReturnType<typeof setTimeout> | null;
}

const entries = new WeakMap<Blob, ObjectUrlEntry>();

function retain(blob: Blob): void {
  const existing = entries.get(blob);
  if (existing === undefined) {
    entries.set(blob, { url: URL.createObjectURL(blob), holders: 1, revokeTimer: null });
    return;
  }
  existing.holders += 1;
  if (existing.revokeTimer !== null) {
    clearTimeout(existing.revokeTimer);
    existing.revokeTimer = null;
  }
}

function release(blob: Blob): void {
  const entry = entries.get(blob);
  if (entry === undefined) {
    return;
  }
  entry.holders -= 1;
  if (entry.holders > 0) {
    return;
  }
  entry.revokeTimer = setTimeout(() => {
    if (entry.holders === 0) {
      URL.revokeObjectURL(entry.url);
      entries.delete(blob);
    }
  }, 0);
}

interface ObjectUrlStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => string | null;
}

const subscribeToNothing = (): (() => void) => () => undefined;

const readNoUrl = (): string | null => null;

const EMPTY_STORE: ObjectUrlStore = { subscribe: subscribeToNothing, getSnapshot: readNoUrl };

function storeFor(blob: Blob | null): ObjectUrlStore {
  if (blob === null) {
    return EMPTY_STORE;
  }
  return {
    subscribe: (listener) => {
      retain(blob);
      listener();
      return () => release(blob);
    },
    getSnapshot: () => entries.get(blob)?.url ?? null,
  };
}

export function useObjectUrl(blob: Blob | null): string | null {
  const store = useMemo(() => storeFor(blob), [blob]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, readNoUrl);
}
