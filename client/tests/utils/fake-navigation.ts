import { useSyncExternalStore } from "react";

type Listener = () => void;

const listeners = new Set<Listener>();
let snapshot = { search: "", params: new URLSearchParams() };

function notify(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

function readSnapshot() {
  const search = window.location.search;
  if (search !== snapshot.search) {
    snapshot = { search, params: new URLSearchParams(search) };
  }
  return snapshot;
}

export function useSearchParams(): URLSearchParams {
  return useSyncExternalStore(subscribe, readSnapshot, readSnapshot).params;
}

export function usePathname(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.pathname,
    () => window.location.pathname,
  );
}

export interface HistoryCalls {
  replace: string[];
  push: string[];
}

export function trackHistory(): { calls: HistoryCalls; restore: () => void } {
  const originalReplace = window.history.replaceState.bind(window.history);
  const originalPush = window.history.pushState.bind(window.history);
  const calls: HistoryCalls = { replace: [], push: [] };
  window.history.replaceState = (data, unused, url) => {
    originalReplace(data, unused, url);
    calls.replace.push(String(url));
    notify();
  };
  window.history.pushState = (data, unused, url) => {
    originalPush(data, unused, url);
    calls.push.push(String(url));
    notify();
  };
  return {
    calls,
    restore: () => {
      window.history.replaceState = originalReplace;
      window.history.pushState = originalPush;
    },
  };
}

export function setLocationSilently(path: string): void {
  History.prototype.replaceState.call(window.history, null, "", path);
}

export function resetLocation(path: string = "/"): void {
  setLocationSilently(path);
  snapshot = {
    search: window.location.search,
    params: new URLSearchParams(window.location.search),
  };
}
