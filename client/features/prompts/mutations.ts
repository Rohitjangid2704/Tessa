import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import type { PromptIssueCreateAny } from "@/lib/api/types";

export interface IssuePromptVariables {
  params: PromptIssueCreateAny;
  idempotencyKey?: string;
}

export function useIssuePrompt(targetId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ params, idempotencyKey }: IssuePromptVariables) =>
      unwrap(
        api.POST("/api/v1/targets/{target_id}/prompt-issues", {
          params: {
            path: { target_id: targetId },
            header:
              idempotencyKey === undefined ? undefined : { "Idempotency-Key": idempotencyKey },
          },
          body: params,
        }),
      ),
    onSuccess: (issue) => {
      queryClient.setQueryData(qk.promptIssues.detail(issue.id), issue);
      void queryClient.invalidateQueries({ queryKey: qk.targets.prompts(targetId) });
    },
  });
}
