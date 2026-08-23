import { api } from "@/lib/api/client";
import { cursorInfiniteOptions } from "@/lib/api/pagination";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import type { FindingStatus } from "@/lib/api/types";
import type { FindingBoardFilters } from "./schemas";

export const FINDINGS_PAGE_SIZE = 25;
export const FINDING_BOARD_SORT = "-last_seen_at,-severity";
export const RUN_OPTIONS_LIMIT = 50;

export function findingsColumnQuery(
  targetId: string,
  filters: FindingBoardFilters,
  status: FindingStatus,
  pageSize: number = FINDINGS_PAGE_SIZE,
) {
  return cursorInfiniteOptions({
    queryKey: qk.findings.list({ target_id: targetId, ...filters, limit: pageSize }, status),
    fetchPage: ({ cursor, signal }) =>
      unwrap(
        api.GET("/api/v1/findings", {
          params: {
            query: {
              target_id: targetId,
              ...filters,
              status: [status],
              sort: FINDING_BOARD_SORT,
              cursor,
              limit: pageSize,
              include_total: true,
            },
          },
          signal,
        }),
      ),
  });
}
