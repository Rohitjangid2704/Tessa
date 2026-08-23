import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useEffect, useReducer, useState } from "react";
import { toast } from "sonner";
import { readRequestId } from "@/components/states/request-id";
import { describeApiError } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type {
  LabelCreate,
  LabelStats,
  LabelTask,
  LabelTaskPage,
  LabelValue,
} from "@/lib/api/types";
import { AttemptKeyRing, labelFingerprint } from "./attempt-keys";
import { useCreateLabel, useDeleteLabel } from "./mutations";
import { labelQueueQuery } from "./queries";
import {
  canUndo,
  deriveBuffer,
  initialQueueState,
  queueReducer,
  shouldPrefetch,
} from "./queue-reducer";
import { describeLabeled, type QueueFilters } from "./schemas";

const NO_TASKS: readonly LabelTask[] = [];

export interface QueueFailure {
  message: string;
  requestId: string | null;
}

export interface LastAnsweredCard {
  task: LabelTask;
  value: LabelValue;
}

interface QueueSelection {
  tasks: readonly LabelTask[];
  firstTotal: number | null;
}

function selectQueue(data: InfiniteData<LabelTaskPage, string | null>): QueueSelection {
  return {
    tasks: data.pages.flatMap((page) => page.items),
    firstTotal: data.pages[0]?.total ?? null,
  };
}

function toFailure(error: unknown): QueueFailure {
  return { message: describeApiError(error), requestId: readRequestId(error) };
}

export interface LabelQueueOptions {
  onRollback?: () => void;
}

export function useLabelQueue(filters: QueueFilters, options: LabelQueueOptions = {}) {
  const queryClient = useQueryClient();
  const query = useInfiniteQuery({ ...labelQueueQuery(filters), select: selectQueue });
  const [state, dispatch] = useReducer(queueReducer, initialQueueState);
  const [announcement, setAnnouncement] = useState("");
  const [failure, setFailure] = useState<QueueFailure | null>(null);
  const [attemptKeys] = useState(() => new AttemptKeyRing());
  const createLabel = useCreateLabel();
  const deleteLabel = useDeleteLabel();

  const tasks = query.data?.tasks ?? NO_TASKS;
  const firstTotal = query.data?.firstTotal ?? null;
  const buffer = deriveBuffer(tasks, state);
  const current = buffer[0] ?? null;
  const lastTask =
    state.last === null ? undefined : tasks.find((task) => task.id === state.last?.taskId);
  const lastAnswered: LastAnsweredCard | null =
    state.last === null || lastTask === undefined
      ? null
      : { task: lastTask, value: state.last.value };

  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = query;
  const needsMore = shouldPrefetch({
    remaining: buffer.length,
    hasNextPage,
    isFetchingNextPage,
    hasFetchError: isFetchNextPageError,
  });

  useEffect(() => {
    if (needsMore) {
      void fetchNextPage();
    }
  }, [needsMore, fetchNextPage]);

  function answer(value: LabelValue): void {
    if (current === null) {
      return;
    }
    const task = current;
    const label: LabelCreate = {
      subject_type: task.subject_type,
      subject_id: task.subject_id,
      value,
    };
    const fingerprint = labelFingerprint(label);
    const stats = queryClient.getQueryData<LabelStats>(qk.labels.stats());
    setFailure(null);
    setAnnouncement(describeLabeled(value, stats === undefined ? null : stats.total_human + 1));
    dispatch({ type: "answer", taskId: task.id, value });
    createLabel
      .mutateAsync({
        label,
        idempotencyKey: attemptKeys.keyFor(fingerprint),
        runId: task.run_id,
        optimisticStats: true,
      })
      .then((result) => {
        attemptKeys.settle(fingerprint);
        dispatch({ type: "confirm", taskId: task.id, labelId: result.label.id });
      })
      .catch((error: unknown) => {
        const reported = toFailure(error);
        dispatch({ type: "rollback", taskId: task.id });
        setFailure(reported);
        setAnnouncement("could not save the label, the card is back");
        toast.error("Could not save your label", { description: reported.message });
        options.onRollback?.();
      });
  }

  function skip(): void {
    if (current === null) {
      return;
    }
    dispatch({ type: "skip", taskId: current.id });
    setAnnouncement("skipped, the card goes to the end of the queue");
  }

  function undo(): void {
    const last = state.last;
    if (last === null || last.labelId === null || !canUndo(state)) {
      return;
    }
    const task = tasks.find((candidate) => candidate.id === last.taskId);
    if (task === undefined) {
      return;
    }
    const labelId = last.labelId;
    setFailure(null);
    dispatch({ type: "undo" });
    setAnnouncement("undid your last label, the card is back");
    deleteLabel
      .mutateAsync({
        label: { id: labelId, subject_type: task.subject_type, subject_id: task.subject_id },
        runId: task.run_id,
        optimisticStats: true,
      })
      .catch((error: unknown) => {
        const reported = toFailure(error);
        dispatch({ type: "undo_failed", last });
        setFailure(reported);
        setAnnouncement("could not undo the label");
        toast.error("Could not undo your label", { description: reported.message });
        options.onRollback?.();
      });
  }

  return {
    query,
    current,
    buffer,
    remaining:
      firstTotal === null ? buffer.length : Math.max(0, firstTotal - state.answered.length),
    answeredCount: state.answered.length,
    skippedCount: state.skipped.length,
    pending: state.pending,
    canUndo: canUndo(state),
    lastAnswered,
    announcement,
    failure,
    dismissFailure: () => setFailure(null),
    answer,
    skip,
    undo,
  };
}
