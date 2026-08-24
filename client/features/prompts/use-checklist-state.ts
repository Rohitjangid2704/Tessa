import { useSyncExternalStore } from "react";

export const CHECKLIST_STORAGE_PREFIX = "tessa.prompt-checklist.";

export interface ChecklistStep {
  id: string;
  label: string;
}

export const CHECKLIST_STEPS: readonly ChecklistStep[] = [
  { id: "open_vscode", label: "Open VS Code" },
  { id: "open_project", label: "Open the project folder of the app under test" },
  { id: "open_claude_code", label: "Open Claude Code in that window" },
  { id: "paste_prompt", label: "Paste the prompt and send it" },
  { id: "wait_for_folder", label: "Wait until a Tessa/ folder appears in the project" },
  { id: "zip_folder", label: "Zip the tessa/ folder" },
  { id: "upload_zip", label: "Upload the zip on the Bundles tab" },
];

const KNOWN_STEP_IDS = new Set(CHECKLIST_STEPS.map((step) => step.id));

type Listener = () => void;

const listenersByIssue = new Map<string, Set<Listener>>();
const memoryByIssue = new Map<string, string>();

function storageKey(issueId: string): string {
  return `${CHECKLIST_STORAGE_PREFIX}${issueId}`;
}

function readRaw(issueId: string): string | null {
  try {
    return window.localStorage.getItem(storageKey(issueId)) ?? memoryByIssue.get(issueId) ?? null;
  } catch {
    return memoryByIssue.get(issueId) ?? null;
  }
}

function writeRaw(issueId: string, raw: string | null): void {
  try {
    if (raw === null) {
      window.localStorage.removeItem(storageKey(issueId));
    } else {
      window.localStorage.setItem(storageKey(issueId), raw);
    }
    memoryByIssue.delete(issueId);
  } catch {
    if (raw === null) {
      memoryByIssue.delete(issueId);
    } else {
      memoryByIssue.set(issueId, raw);
    }
  }
  for (const listener of [...(listenersByIssue.get(issueId) ?? [])]) {
    listener();
  }
}

export function parseCompletedSteps(raw: string | null): ReadonlySet<string> {
  if (raw === null) {
    return new Set();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(
      parsed.filter((id): id is string => typeof id === "string" && KNOWN_STEP_IDS.has(id)),
    );
  } catch {
    return new Set();
  }
}

function serializeCompletedSteps(completed: ReadonlySet<string>): string | null {
  const ordered = CHECKLIST_STEPS.filter((step) => completed.has(step.id)).map((step) => step.id);
  return ordered.length === 0 ? null : JSON.stringify(ordered);
}

function subscribeToIssue(issueId: string, listener: Listener): () => void {
  const listeners = listenersByIssue.get(issueId) ?? new Set<Listener>();
  listeners.add(listener);
  listenersByIssue.set(issueId, listeners);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === storageKey(issueId)) {
      listener();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      listenersByIssue.delete(issueId);
    }
    window.removeEventListener("storage", onStorage);
  };
}

const readNothingOnServer = (): null => null;

export interface ChecklistState {
  steps: readonly ChecklistStep[];
  completed: ReadonlySet<string>;
  completedCount: number;
  total: number;
  isDone: (stepId: string) => boolean;
  setDone: (stepId: string, done: boolean) => void;
  reset: () => void;
}

export function useChecklistState(issueId: string): ChecklistState {
  const raw = useSyncExternalStore(
    (listener) => subscribeToIssue(issueId, listener),
    () => readRaw(issueId),
    readNothingOnServer,
  );
  const completed = parseCompletedSteps(raw);

  function setDone(stepId: string, done: boolean): void {
    if (!KNOWN_STEP_IDS.has(stepId)) {
      return;
    }
    const next = new Set(parseCompletedSteps(readRaw(issueId)));
    if (done) {
      next.add(stepId);
    } else {
      next.delete(stepId);
    }
    writeRaw(issueId, serializeCompletedSteps(next));
  }

  return {
    steps: CHECKLIST_STEPS,
    completed,
    completedCount: completed.size,
    total: CHECKLIST_STEPS.length,
    isDone: (stepId) => completed.has(stepId),
    setDone,
    reset: () => writeRaw(issueId, null),
  };
}
