import { describe, expect, it } from "vitest";
import type { LabelTask } from "@/lib/api/types";
import {
  canUndo,
  deriveBuffer,
  initialQueueState,
  QUEUE_PREFETCH_AT,
  queueReducer,
  shouldPrefetch,
  type QueueAction,
  type QueueState,
} from "./queue-reducer";

function task(index: number): LabelTask {
  return {
    id: `task-${index}`,
    subject_type: "step",
    subject_id: `subject-${index}`,
    step_id: `step-${index}`,
    run_id: "run-1",
    question: `Question ${index}`,
    machine_value: "pass",
    machine_confidence: 0.6,
    evidence_excerpt: "text",
    reason: "uncertain",
    created_at: "2026-10-02T09:00:00.000Z",
  };
}

const TASKS = [1, 2, 3, 4].map(task);

function run(actions: readonly QueueAction[], from: QueueState = initialQueueState): QueueState {
  return actions.reduce(queueReducer, from);
}

function ids(state: QueueState, tasks: readonly LabelTask[] = TASKS): string[] {
  return deriveBuffer(tasks, state).map((entry) => entry.id);
}

describe("queueReducer answer", () => {
  it("removes the card from the buffer at once and counts the request in flight", () => {
    const state = run([{ type: "answer", taskId: "task-1", value: "pass" }]);

    expect(ids(state)).toEqual(["task-2", "task-3", "task-4"]);
    expect(state.pending).toBe(1);
    expect(state.last).toEqual({ taskId: "task-1", labelId: null, value: "pass" });
    expect(canUndo(state)).toBe(false);
  });

  it("advances one card per answer in server order", () => {
    const state = run([
      { type: "answer", taskId: "task-1", value: "pass" },
      { type: "answer", taskId: "task-2", value: "fail" },
    ]);

    expect(ids(state)).toEqual(["task-3", "task-4"]);
    expect(state.pending).toBe(2);
    expect(state.last?.taskId).toBe("task-2");
  });

  it("does not list a task twice when it is answered twice", () => {
    const state = run([
      { type: "answer", taskId: "task-1", value: "pass" },
      { type: "answer", taskId: "task-1", value: "fail" },
    ]);

    expect(state.answered).toEqual(["task-1"]);
  });
});

describe("queueReducer confirm", () => {
  it("stores the label id of the latest answer so it can be undone", () => {
    const state = run([
      { type: "answer", taskId: "task-1", value: "pass" },
      { type: "confirm", taskId: "task-1", labelId: "label-1" },
    ]);

    expect(state.pending).toBe(0);
    expect(state.last).toEqual({ taskId: "task-1", labelId: "label-1", value: "pass" });
    expect(canUndo(state)).toBe(true);
  });

  it("ignores the label of an older answer for undo but still settles the request", () => {
    const state = run([
      { type: "answer", taskId: "task-1", value: "pass" },
      { type: "answer", taskId: "task-2", value: "fail" },
      { type: "confirm", taskId: "task-1", labelId: "label-1" },
    ]);

    expect(state.pending).toBe(1);
    expect(state.last).toEqual({ taskId: "task-2", labelId: null, value: "fail" });
    expect(canUndo(state)).toBe(false);
  });
});

describe("queueReducer skip", () => {
  it("moves the card to the end of the buffer", () => {
    const state = run([{ type: "skip", taskId: "task-1" }]);

    expect(ids(state)).toEqual(["task-2", "task-3", "task-4", "task-1"]);
    expect(state.answered).toEqual([]);
    expect(state.last).toBeNull();
  });

  it("keeps skipped cards in the order they were skipped", () => {
    const state = run([
      { type: "skip", taskId: "task-1" },
      { type: "skip", taskId: "task-2" },
    ]);

    expect(ids(state)).toEqual(["task-3", "task-4", "task-1", "task-2"]);
  });

  it("moves a card skipped twice to the very end", () => {
    const state = run([
      { type: "skip", taskId: "task-1" },
      { type: "skip", taskId: "task-2" },
      { type: "skip", taskId: "task-1" },
    ]);

    expect(ids(state)).toEqual(["task-3", "task-4", "task-2", "task-1"]);
  });

  it("leaves a lone card where it is", () => {
    const only = [task(1)];
    const state = run([{ type: "skip", taskId: "task-1" }]);

    expect(ids(state, only)).toEqual(["task-1"]);
  });

  it("drops a skipped card once it is answered", () => {
    const state = run([
      { type: "skip", taskId: "task-1" },
      { type: "answer", taskId: "task-1", value: "uncertain" },
    ]);

    expect(ids(state)).toEqual(["task-2", "task-3", "task-4"]);
    expect(state.skipped).toEqual([]);
  });
});

describe("queueReducer rollback", () => {
  it("puts the card back at the front and clears the pending request", () => {
    const state = run([
      { type: "answer", taskId: "task-1", value: "pass" },
      { type: "rollback", taskId: "task-1" },
    ]);

    expect(ids(state)).toEqual(["task-1", "task-2", "task-3", "task-4"]);
    expect(state.pending).toBe(0);
    expect(state.last).toBeNull();
  });

  it("restores only the failed card when later answers are still in flight", () => {
    const state = run([
      { type: "answer", taskId: "task-1", value: "pass" },
      { type: "answer", taskId: "task-2", value: "fail" },
      { type: "rollback", taskId: "task-1" },
    ]);

    expect(ids(state)).toEqual(["task-1", "task-3", "task-4"]);
    expect(state.pending).toBe(1);
    expect(state.last?.taskId).toBe("task-2");
  });

  it("restores a skipped-then-answered card in front of the rest", () => {
    const state = run([
      { type: "skip", taskId: "task-1" },
      { type: "answer", taskId: "task-2", value: "pass" },
      { type: "rollback", taskId: "task-2" },
    ]);

    expect(ids(state)).toEqual(["task-2", "task-3", "task-4", "task-1"]);
  });
});

describe("queueReducer undo", () => {
  const answered = run([
    { type: "answer", taskId: "task-1", value: "pass" },
    { type: "confirm", taskId: "task-1", labelId: "label-1" },
  ]);

  it("puts the last answered card back in front and forgets the answer", () => {
    const state = queueReducer(answered, { type: "undo" });

    expect(ids(state)).toEqual(["task-1", "task-2", "task-3", "task-4"]);
    expect(state.last).toBeNull();
    expect(canUndo(state)).toBe(false);
  });

  it("is one step deep: a second undo does nothing", () => {
    const once = queueReducer(answered, { type: "undo" });
    const twice = queueReducer(once, { type: "undo" });

    expect(twice).toBe(once);
  });

  it("does nothing while the label id is still unknown", () => {
    const pending = run([{ type: "answer", taskId: "task-1", value: "pass" }]);

    expect(queueReducer(pending, { type: "undo" })).toBe(pending);
  });

  it("undoes only the latest answer when two cards were answered", () => {
    const state = run(
      [
        { type: "answer", taskId: "task-2", value: "fail" },
        { type: "confirm", taskId: "task-2", labelId: "label-2" },
        { type: "undo" },
      ],
      answered,
    );

    expect(ids(state)).toEqual(["task-2", "task-3", "task-4"]);
    expect(state.answered).toEqual(["task-1"]);
  });

  it("re-answers the card when the delete failed", () => {
    const undone = queueReducer(answered, { type: "undo" });
    const last = answered.last;
    if (last === null) {
      throw new Error("expected a last answer");
    }
    const state = queueReducer(undone, { type: "undo_failed", last });

    expect(ids(state)).toEqual(["task-2", "task-3", "task-4"]);
    expect(state.last).toEqual(last);
    expect(canUndo(state)).toBe(true);
  });
});

describe("deriveBuffer", () => {
  it("shows every task in server order for a fresh state", () => {
    expect(ids(initialQueueState)).toEqual(["task-1", "task-2", "task-3", "task-4"]);
  });

  it("ignores ids that are not in the fetched tasks", () => {
    const state: QueueState = {
      ...initialQueueState,
      front: ["missing", "task-3"],
      skipped: ["gone"],
      answered: ["also-gone"],
    };

    expect(ids(state)).toEqual(["task-3", "task-1", "task-2", "task-4"]);
  });

  it("appends tasks that arrive in a later page after the fresh ones and before the skipped", () => {
    const skipped = run([{ type: "skip", taskId: "task-1" }]);
    const more = [...TASKS, task(5), task(6)];

    expect(ids(skipped, more)).toEqual([
      "task-2",
      "task-3",
      "task-4",
      "task-5",
      "task-6",
      "task-1",
    ]);
  });
});

describe("shouldPrefetch", () => {
  const idle = {
    remaining: QUEUE_PREFETCH_AT,
    hasNextPage: true,
    isFetchingNextPage: false,
    hasFetchError: false,
  };

  it("triggers at five cards remaining and below", () => {
    expect(QUEUE_PREFETCH_AT).toBe(5);
    expect(shouldPrefetch({ ...idle, remaining: 6 })).toBe(false);
    expect(shouldPrefetch({ ...idle, remaining: 5 })).toBe(true);
    expect(shouldPrefetch({ ...idle, remaining: 0 })).toBe(true);
  });

  it("does not fetch without a next page, while fetching or after a failed fetch", () => {
    expect(shouldPrefetch({ ...idle, hasNextPage: false })).toBe(false);
    expect(shouldPrefetch({ ...idle, isFetchingNextPage: true })).toBe(false);
    expect(shouldPrefetch({ ...idle, hasFetchError: true })).toBe(false);
  });
});
