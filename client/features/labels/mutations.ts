import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { ApiError } from "@/lib/api/errors";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import type { Label, LabelCreate, LabelStats, LabelSubjectType } from "@/lib/api/types";
import { unwrap } from "@/lib/api/unwrap";

export const LABEL_REPLACED_STATUS = 200;

export interface CreateLabelVariables {
  label: LabelCreate;
  idempotencyKey: string;
  runId?: string | null;
  optimisticStats?: boolean;
}

export interface CreateLabelResult {
  label: Label;
  replaced: boolean;
}

export interface DeleteLabelVariables {
  label: Pick<Label, "id" | "subject_type" | "subject_id">;
  runId?: string | null;
  optimisticStats?: boolean;
}

export async function postLabel({
  label,
  idempotencyKey,
}: Pick<CreateLabelVariables, "label" | "idempotencyKey">): Promise<CreateLabelResult> {
  const result = await api.POST("/api/v1/labels", {
    params: { header: { "Idempotency-Key": idempotencyKey } },
    body: label,
  });
  if (!result.response.ok || result.data === undefined) {
    throw ApiError.fromResponse(result.response, result.error);
  }
  return { label: result.data, replaced: result.response.status === LABEL_REPLACED_STATUS };
}

export function adjustStats(
  stats: LabelStats,
  subjectType: LabelSubjectType,
  delta: number,
): LabelStats {
  return {
    ...stats,
    total_human: Math.max(0, stats.total_human + delta),
    by_subject_type: {
      ...stats.by_subject_type,
      [subjectType]: Math.max(0, (stats.by_subject_type[subjectType] ?? 0) + delta),
    },
  };
}

function adjustCachedStats(
  queryClient: QueryClient,
  subjectType: LabelSubjectType,
  delta: number,
): void {
  queryClient.setQueryData<LabelStats>(qk.labels.stats(), (previous) =>
    previous === undefined ? previous : adjustStats(previous, subjectType, delta),
  );
}

export interface LabelSubject {
  subjectType: LabelSubjectType;
  subjectId: string;
  runId?: string | null;
}

export function invalidateAfterLabelChange(queryClient: QueryClient, subject: LabelSubject): void {
  void queryClient.invalidateQueries({ queryKey: qk.labels.lists() });
  if (subject.subjectType === "step") {
    void queryClient.invalidateQueries({ queryKey: qk.runs.lists() });
    void queryClient.invalidateQueries({
      queryKey:
        subject.runId === undefined || subject.runId === null
          ? qk.runs.all()
          : qk.runs.forRun(subject.runId),
    });
    void queryClient.invalidateQueries({ queryKey: qk.runScenarios.all() });
    void queryClient.invalidateQueries({ queryKey: qk.steps.detail(subject.subjectId) });
  }
}

export function useCreateLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: (variables: CreateLabelVariables) => postLabel(variables),
    onMutate: async (variables) => {
      if (variables.optimisticStats === true) {
        await queryClient.cancelQueries({ queryKey: qk.labels.stats() });
        adjustCachedStats(queryClient, variables.label.subject_type, 1);
      }
    },
    onError: (_error, variables) => {
      if (variables.optimisticStats === true) {
        adjustCachedStats(queryClient, variables.label.subject_type, -1);
      }
    },
    onSuccess: (result, variables) => {
      queryClient.setQueryData(
        qk.labels.own(variables.label.subject_type, variables.label.subject_id),
        result.label,
      );
      invalidateAfterLabelChange(queryClient, {
        subjectType: variables.label.subject_type,
        subjectId: variables.label.subject_id,
        runId: variables.runId,
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qk.labels.stats() });
    },
  });
}

export function useDeleteLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: async ({ label }: DeleteLabelVariables) => {
      await unwrap(
        api.DELETE("/api/v1/labels/{label_id}", { params: { path: { label_id: label.id } } }),
      );
    },
    onMutate: async ({ label, optimisticStats }) => {
      const ownKey = qk.labels.own(label.subject_type, label.subject_id);
      const previousOwn = queryClient.getQueryData(ownKey);
      queryClient.setQueryData(ownKey, null);
      if (optimisticStats === true) {
        await queryClient.cancelQueries({ queryKey: qk.labels.stats() });
        adjustCachedStats(queryClient, label.subject_type, -1);
      }
      return { previousOwn };
    },
    onError: (_error, { label, optimisticStats }, context) => {
      if (context?.previousOwn !== undefined) {
        queryClient.setQueryData(
          qk.labels.own(label.subject_type, label.subject_id),
          context.previousOwn,
        );
      }
      if (optimisticStats === true) {
        adjustCachedStats(queryClient, label.subject_type, 1);
      }
    },
    onSuccess: (_result, { label, runId }) => {
      invalidateAfterLabelChange(queryClient, {
        subjectType: label.subject_type,
        subjectId: label.subject_id,
        runId,
      });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qk.labels.stats() });
    },
  });
}
