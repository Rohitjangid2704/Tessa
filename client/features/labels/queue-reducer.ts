import type { LabelTask, LabelValue } from "@/lib/api/types";

export const QUEUE_PREFETCH_AT = 5;

export interface LastAnswer {
  taskId: string;
  labelId: string | null;
  value: LabelValue;
}

export interface QueueState {
  answered: readonly string[];
  skipped: readonly string[];
  front: readonly string[];
  last: LastAnswer | null;
  pending: number;
}

export type QueueAction =
  | { type: "answer"; taskId: string; value: LabelValue }
  | { type: "confirm"; taskId: string; labelId: string }
  | { type: "rollback"; taskId: string }
  | { type: "skip"; taskId: string }
  | { type: "undo" }
  | { type: "undo_failed"; last: LastAnswer };

export const initialQueueState: QueueState = {
  answered: [],
  skipped: [],
  front: [],
  last: null,
  pending: 0,
};

function without(ids: readonly string[], taskId: string): readonly string[] {
  return ids.filter((id) => id !== taskId);
}

function withFirst(ids: readonly string[], taskId: string): readonly string[] {
  return [taskId, ...without(ids, taskId)];
}

export function queueReducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case "answer":
      return {
        ...state,
        answered: [...without(state.answered, action.taskId), action.taskId],
        skipped: without(state.skipped, action.taskId),
        front: without(state.front, action.taskId),
        last: { taskId: action.taskId, labelId: null, value: action.value },
        pending: state.pending + 1,
      };
    case "confirm":
      return {
        ...state,
        pending: Math.max(0, state.pending - 1),
        last:
          state.last?.taskId === action.taskId
            ? { ...state.last, labelId: action.labelId }
            : state.last,
      };
    case "rollback":
      return {
        ...state,
        answered: without(state.answered, action.taskId),
        front: withFirst(state.front, action.taskId),
        last: state.last?.taskId === action.taskId ? null : state.last,
        pending: Math.max(0, state.pending - 1),
      };
    case "skip":
      return {
        ...state,
        skipped: [...without(state.skipped, action.taskId), action.taskId],
        front: without(state.front, action.taskId),
      };
    case "undo":
      if (state.last === null || state.last.labelId === null) {
        return state;
      }
      return {
        ...state,
        answered: without(state.answered, state.last.taskId),
        front: withFirst(state.front, state.last.taskId),
        last: null,
      };
    case "undo_failed":
      return {
        ...state,
        answered: [...without(state.answered, action.last.taskId), action.last.taskId],
        front: without(state.front, action.last.taskId),
        last: action.last,
      };
  }
}

export function canUndo(state: QueueState): boolean {
  return state.last !== null && state.last.labelId !== null;
}

export function deriveBuffer(
  tasks: readonly LabelTask[],
  state: Pick<QueueState, "answered" | "skipped" | "front">,
): LabelTask[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const answered = new Set(state.answered);
  const frontIds = state.front.filter((id) => !answered.has(id));
  const placed = new Set([...frontIds, ...state.skipped]);
  const front = frontIds.flatMap((id) => byId.get(id) ?? []);
  const fresh = tasks.filter((task) => !answered.has(task.id) && !placed.has(task.id));
  const skipped = state.skipped
    .filter((id) => !answered.has(id) && !frontIds.includes(id))
    .flatMap((id) => byId.get(id) ?? []);
  return [...front, ...fresh, ...skipped];
}

export interface PrefetchInput {
  remaining: number;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  hasFetchError: boolean;
}

export function shouldPrefetch({
  remaining,
  hasNextPage,
  isFetchingNextPage,
  hasFetchError,
}: PrefetchInput): boolean {
  return remaining <= QUEUE_PREFETCH_AT && hasNextPage && !isFetchingNextPage && !hasFetchError;
}
