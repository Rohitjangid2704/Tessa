import { useSyncExternalStore } from "react";

const subscribeToNothing = () => () => {};
const readHydrated = () => true;
const readServerSnapshot = () => false;

export function useHydrated(): boolean {
  return useSyncExternalStore(subscribeToNothing, readHydrated, readServerSnapshot);
}
