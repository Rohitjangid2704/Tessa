import { useSyncExternalStore } from "react";
import type { LabelReason } from "@/lib/api/types";
import { isAlwaysBlind } from "./schemas";

export const REVEAL_MACHINE_STORAGE_KEY = "tessa.labels.reveal-machine-value";

const REVEAL_VALUE = "yes";

const listeners = new Set<() => void>();
let memoryReveal: boolean | null = null;

function readStoredReveal(): boolean {
  try {
    return window.localStorage.getItem(REVEAL_MACHINE_STORAGE_KEY) === REVEAL_VALUE;
  } catch {
    return false;
  }
}

function writeStoredReveal(reveal: boolean): void {
  try {
    if (reveal) {
      window.localStorage.setItem(REVEAL_MACHINE_STORAGE_KEY, REVEAL_VALUE);
    } else {
      window.localStorage.removeItem(REVEAL_MACHINE_STORAGE_KEY);
    }
  } catch {
    return;
  }
}

function notify(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === REVEAL_MACHINE_STORAGE_KEY || event.key === null) {
      memoryReveal = null;
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function getRevealSnapshot(): boolean {
  return memoryReveal ?? readStoredReveal();
}

function getServerRevealSnapshot(): boolean {
  return false;
}

export function setRevealMachineValue(reveal: boolean): void {
  memoryReveal = reveal;
  writeStoredReveal(reveal);
  notify();
}

export function resetRevealMachineValue(): void {
  memoryReveal = null;
  notify();
}

export function useRevealMachineValue(): readonly [boolean, (reveal: boolean) => void] {
  const reveal = useSyncExternalStore(subscribe, getRevealSnapshot, getServerRevealSnapshot);
  return [reveal, setRevealMachineValue];
}

export interface MachineVisibility {
  reason: LabelReason;
  answered: boolean;
  revealBeforeAnswer: boolean;
}

export function isMachineValueVisible({
  reason,
  answered,
  revealBeforeAnswer,
}: MachineVisibility): boolean {
  if (answered) {
    return true;
  }
  return revealBeforeAnswer && !isAlwaysBlind(reason);
}
