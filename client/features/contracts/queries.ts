import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { cursorInfiniteOptions } from "@/lib/api/pagination";
import { isRunTerminal, polling } from "@/lib/api/polling";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";

export const CONTRACTS_PAGE_SIZE = 25;
export const CONTRACT_LIST_POLL_MS = 2500;
export const CHECK_LOOKUP_PAGE_SIZE = 50;

export interface ContractListFilters {
  consumer_target_id?: string;
  provider_target_id?: string;
}

function hasUnsettledCheck(data: unknown): boolean {
  if (typeof data !== "object" || data === null || !("pages" in data)) {
    return false;
  }
  const { pages } = data;
  if (!Array.isArray(pages)) {
    return false;
  }
  return pages.some((page: unknown) => {
    if (typeof page !== "object" || page === null || !("items" in page)) {
      return false;
    }
    const { items } = page;
    return Array.isArray(items) && items.some((item: unknown) => !isRunTerminal(item));
  });
}

export function contractChecksListQuery(
  filters: ContractListFilters = {},
  pageSize = CONTRACTS_PAGE_SIZE,
) {
  return {
    ...cursorInfiniteOptions({
      queryKey: qk.contracts.list({ ...filters, limit: pageSize }),
      staleTime: 0,
      fetchPage: ({ cursor, signal }) =>
        unwrap(
          api.GET("/api/v1/contract-checks", {
            params: {
              query: { ...filters, cursor, limit: pageSize, include_total: true },
            },
            signal,
          }),
        ),
    }),
    refetchInterval: (query: { state: { data: unknown } }) =>
      hasUnsettledCheck(query.state.data) ? CONTRACT_LIST_POLL_MS : false,
    refetchIntervalInBackground: false,
  };
}

export function contractCheckQuery(contractCheckId: string) {
  return {
    ...queryOptions({
      queryKey: qk.contracts.detail(contractCheckId),
      queryFn: ({ signal }) =>
        unwrap(
          api.GET("/api/v1/contract-checks/{contract_check_id}", {
            params: { path: { contract_check_id: contractCheckId } },
            signal,
          }),
        ),
      staleTime: 0,
      meta: INLINE_ERROR_META,
    }),
    ...polling.run,
  };
}

export function contractCheckForRunQuery(runId: string) {
  return queryOptions({
    queryKey: qk.contracts.list({ for_run: runId, limit: CHECK_LOOKUP_PAGE_SIZE }),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/contract-checks", {
          params: { query: { limit: CHECK_LOOKUP_PAGE_SIZE } },
          signal,
        }),
      ),
    select: (page) => page.items.find((check) => check.run_id === runId) ?? null,
    staleTime: 0,
    meta: INLINE_ERROR_META,
  });
}

export function isContractNotFound(error: unknown): boolean {
  return isApiError(error) && (error.status === 404 || error.status === 422);
}
