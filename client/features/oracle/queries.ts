import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { cursorInfiniteOptions } from "@/lib/api/pagination";
import { isOracleSettled, polling } from "@/lib/api/polling";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import type { OracleApproval } from "./types";

export const ORACLE_TEMPLATES_PAGE_SIZE = 50;
export const ORACLE_RESULTS_PAGE_SIZE = 10;

export interface OracleTemplateFilters {
  targetId: string;
  featureId?: string;
  approval?: OracleApproval[];
}

export function oracleTemplatesQuery({ targetId, featureId, approval }: OracleTemplateFilters) {
  const filters = {
    target_id: targetId,
    feature_id: featureId,
    approval,
    limit: ORACLE_TEMPLATES_PAGE_SIZE,
  };
  return cursorInfiniteOptions({
    queryKey: qk.oracle.templates(filters),
    fetchPage: ({ cursor, signal }) =>
      unwrap(
        api.GET("/api/v1/oracle-templates", {
          params: {
            query: {
              target_id: targetId,
              feature_id: featureId === undefined || featureId === "" ? undefined : [featureId],
              approval,
              limit: ORACLE_TEMPLATES_PAGE_SIZE,
              cursor,
              include_total: true,
            },
          },
          signal,
        }),
      ),
  });
}

export function oracleTemplateQuery(templateId: string) {
  return queryOptions({
    queryKey: qk.oracle.template(templateId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/oracle-templates/{oracle_template_id}", {
          params: { path: { oracle_template_id: templateId } },
          signal,
        }),
      ),
  });
}

export function oracleResultQuery(resultId: string) {
  return queryOptions({
    queryKey: qk.oracle.result(resultId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/oracle-results/{oracle_result_id}", {
          params: { path: { oracle_result_id: resultId } },
          signal,
        }),
      ),
    staleTime: (query) => (isOracleSettled(query.state.data) ? Infinity : 0),
    ...polling.oracle,
  });
}

export function oracleResultsQuery(templateId: string) {
  return cursorInfiniteOptions({
    queryKey: qk.oracle.results(templateId),
    fetchPage: ({ cursor, signal }) =>
      unwrap(
        api.GET("/api/v1/oracle-templates/{oracle_template_id}/results", {
          params: {
            path: { oracle_template_id: templateId },
            query: { cursor, limit: ORACLE_RESULTS_PAGE_SIZE, include_total: true },
          },
          signal,
        }),
      ),
  });
}
