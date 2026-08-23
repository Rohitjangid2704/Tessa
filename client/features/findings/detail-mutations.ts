import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { describeApiError, isApiError } from "@/lib/api/errors";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import type { Finding, FindingUpdate } from "@/lib/api/types";
import { unwrap } from "@/lib/api/unwrap";
import { beginLocalMove, endLocalMove } from "./local-moves";

const pendingLocalUpdates = new Set<string>();

export function isLocalUpdatePending(findingId: string): boolean {
  return pendingLocalUpdates.has(findingId);
}

function idempotencyHeader(idempotencyKey: string | undefined) {
  return idempotencyKey === undefined ? undefined : { "Idempotency-Key": idempotencyKey };
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return isApiError(error) && error.details.some((detail) => detail.code === code);
}

export function describeFindingUpdateError(error: unknown): string {
  if (!isApiError(error)) {
    return describeApiError(error);
  }
  if (error.status === 409 && hasErrorCode(error, "transition_not_allowed")) {
    return "That move is not allowed from the current column. The finding was reloaded.";
  }
  if (error.status === 403) {
    return "Your role cannot change findings. Ask a member or an admin.";
  }
  if (error.status === 404) {
    return "This finding no longer exists.";
  }
  if (error.status === 422) {
    return error.details[0]?.message ?? describeApiError(error);
  }
  return describeApiError(error);
}

export function useUpdateFindingDetail(findingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: (patch: FindingUpdate) =>
      unwrap(
        api.PATCH("/api/v1/findings/{finding_id}", {
          params: { path: { finding_id: findingId } },
          body: patch,
        }),
      ),
    onMutate: () => {
      pendingLocalUpdates.add(findingId);
      beginLocalMove(findingId);
    },
    onSuccess: (finding: Finding) => {
      endLocalMove(findingId, finding.status, Date.now());
      queryClient.setQueryData(qk.findings.detail(findingId), finding);
    },
    onError: (error) => {
      endLocalMove(findingId, null, Date.now());
      if (isApiError(error) && error.status === 409) {
        void queryClient.invalidateQueries({ queryKey: qk.findings.detail(findingId) });
      }
    },
    onSettled: () => {
      pendingLocalUpdates.delete(findingId);
      void queryClient.invalidateQueries({ queryKey: qk.findings.lists() });
    },
  });
}

export interface IssueExplainPromptVariables {
  idempotencyKey?: string;
}

export function useIssueExplainPrompt(targetId: string, findingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ idempotencyKey }: IssueExplainPromptVariables) =>
      unwrap(
        api.POST("/api/v1/targets/{target_id}/prompt-issues", {
          params: {
            path: { target_id: targetId },
            header: idempotencyHeader(idempotencyKey),
          },
          body: { template_name: "explain", finding_id: findingId },
        }),
      ),
    onSuccess: (issue) => {
      queryClient.setQueryData(qk.promptIssues.explain(findingId), issue);
      queryClient.setQueryData(qk.promptIssues.detail(issue.id), issue);
      void queryClient.invalidateQueries({ queryKey: qk.targets.prompts(targetId) });
    },
  });
}

export interface AddExplanationVariables {
  text: string;
  idempotencyKey: string;
}

export function useAddExplanation(findingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ text, idempotencyKey }: AddExplanationVariables) =>
      unwrap(
        api.POST("/api/v1/findings/{finding_id}/explanations", {
          params: {
            path: { finding_id: findingId },
            header: idempotencyHeader(idempotencyKey),
          },
          body: { text },
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.findings.explanations(findingId) });
      void queryClient.invalidateQueries({ queryKey: qk.findings.detail(findingId) });
    },
  });
}

export function describeExplanationError(error: unknown, maxChars: number | null): string {
  if (!isApiError(error)) {
    return describeApiError(error);
  }
  if (error.status === 422 && hasErrorCode(error, "string_too_long")) {
    return maxChars === null
      ? "The explanation is longer than the server allows. Shorten it and try again."
      : `The explanation is longer than the server allows (${maxChars.toLocaleString("en-US")} characters). Shorten it and try again.`;
  }
  if (error.status === 403) {
    return "Your role cannot add explanations. Ask a member or an admin.";
  }
  if (error.status === 404) {
    return "This finding no longer exists.";
  }
  if (error.status === 422) {
    return error.details[0]?.message ?? describeApiError(error);
  }
  return describeApiError(error);
}

export interface PromoteFindingVariables {
  title: string | null;
  idempotencyKey: string;
}

export function usePromoteFinding(findingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ title, idempotencyKey }: PromoteFindingVariables) =>
      unwrap(
        api.POST("/api/v1/findings/{finding_id}/promote", {
          params: {
            path: { finding_id: findingId },
            header: idempotencyHeader(idempotencyKey),
          },
          body: title === null ? {} : { title },
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.findings.all() });
      void queryClient.invalidateQueries({ queryKey: qk.scenarios.all() });
    },
  });
}

export function describePromoteError(error: unknown): string {
  if (!isApiError(error)) {
    return describeApiError(error);
  }
  if (error.status === 409) {
    return "This finding was already promoted, or its repro cannot be turned into a scenario.";
  }
  if (error.status === 403) {
    return "Your role cannot promote findings. Ask a member or an admin.";
  }
  if (error.status === 404) {
    return "This finding no longer exists.";
  }
  if (error.status === 422) {
    return error.details[0]?.message ?? describeApiError(error);
  }
  return describeApiError(error);
}
