import { queryOptions, useQuery } from "@tanstack/react-query";
import { meQuery } from "@/features/system/queries";
import { api } from "@/lib/api/client";
import { cursorInfiniteOptions } from "@/lib/api/pagination";
import { qk } from "@/lib/api/query-keys";
import type { LabelSubjectType } from "@/lib/api/types";
import { unwrap } from "@/lib/api/unwrap";
import type { QueueFilters } from "./schemas";

export const QUEUE_PAGE_SIZE = 20;

export function labelQueueQuery(filters: QueueFilters, pageSize: number = QUEUE_PAGE_SIZE) {
  return cursorInfiniteOptions({
    queryKey: qk.labels.queue({ ...filters, limit: pageSize }),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    fetchPage: ({ cursor, signal }) =>
      unwrap(
        api.GET("/api/v1/labels/queue", {
          params: {
            query: {
              subject_type: filters.subject_type,
              reason: filters.reason,
              target_id: filters.target_id,
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

export function labelStatsQuery() {
  return queryOptions({
    queryKey: qk.labels.stats(),
    queryFn: ({ signal }) => unwrap(api.GET("/api/v1/labels/stats", { signal })),
  });
}

export interface OwnLabelRequest {
  subjectType: LabelSubjectType;
  subjectId: string;
  userId: string;
}

export function ownLabelQuery({ subjectType, subjectId, userId }: OwnLabelRequest) {
  return queryOptions({
    queryKey: qk.labels.own(subjectType, subjectId),
    queryFn: async ({ signal }) => {
      const page = await unwrap(
        api.GET("/api/v1/labels", {
          params: {
            query: {
              subject_type: [subjectType],
              subject_id: subjectId,
              source: ["human"],
              labeled_by: userId,
              limit: 1,
            },
          },
          signal,
        }),
      );
      return page.items[0] ?? null;
    },
  });
}

export function useOwnLabel(subjectType: LabelSubjectType, subjectId: string) {
  const me = useQuery(meQuery());
  const userId = me.data?.id;
  const query = useQuery({
    ...ownLabelQuery({ subjectType, subjectId, userId: userId ?? "" }),
    enabled: userId !== undefined,
  });
  return {
    label: query.data ?? null,
    isPending: userId === undefined || query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}
