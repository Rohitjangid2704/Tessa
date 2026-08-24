import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import type { OracleResult, OracleTemplate, OracleTemplatePage } from "./types";

export interface RunOracleVariables {
  params: Record<string, unknown>;
  idempotencyKey: string;
}

export interface SetApprovalVariables {
  approved: boolean;
  oracleResultId: string;
}

export function useRunOracle(templateId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ params, idempotencyKey }: RunOracleVariables) =>
      unwrap(
        api.POST("/api/v1/oracle-templates/{oracle_template_id}/runs", {
          params: {
            path: { oracle_template_id: templateId },
            header: { "Idempotency-Key": idempotencyKey },
          },
          body: { params },
        }),
      ),
    onSuccess: (result: OracleResult) => {
      queryClient.setQueryData(qk.oracle.result(result.id), result);
      void queryClient.invalidateQueries({ queryKey: qk.oracle.results(templateId) });
    },
  });
}

export function replaceTemplateInPages(
  data: InfiniteData<OracleTemplatePage, string | null> | undefined,
  updated: OracleTemplate,
): InfiniteData<OracleTemplatePage, string | null> | undefined {
  if (data === undefined) {
    return data;
  }
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((item) => (item.id === updated.id ? updated : item)),
    })),
  };
}

export function useSetApproval(templateId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ approved, oracleResultId }: SetApprovalVariables) =>
      unwrap(
        api.PUT("/api/v1/oracle-templates/{oracle_template_id}/approval", {
          params: { path: { oracle_template_id: templateId } },
          body: { approved, oracle_result_id: oracleResultId },
        }),
      ),
    onSuccess: (template: OracleTemplate) => {
      queryClient.setQueryData(qk.oracle.template(templateId), template);
      queryClient.setQueriesData<InfiniteData<OracleTemplatePage, string | null>>(
        { queryKey: qk.oracle.templateLists() },
        (data) => replaceTemplateInPages(data, template),
      );
      void queryClient.invalidateQueries({ queryKey: qk.oracle.templateLists() });
    },
  });
}
