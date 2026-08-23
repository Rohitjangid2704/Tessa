import { useInfiniteQuery, type UseInfiniteQueryResult } from "@tanstack/react-query";
import type { CursorResult } from "@/lib/api/pagination";
import type { FindingStatus, FindingSummary } from "@/lib/api/types";
import { useHydrated } from "@/lib/use-hydrated";
import { findingsColumnQuery } from "./queries";
import type { FindingBoardFilters } from "./schemas";

export interface ColumnData {
  status: FindingStatus;
  cards: readonly FindingSummary[];
  total: number | null;
  isPending: boolean;
  isFetching: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  error: unknown;
  retry: () => void;
  loadMore: () => void;
}

export type BoardColumns = Readonly<Record<FindingStatus, ColumnData>>;

type ColumnQuery = UseInfiniteQueryResult<CursorResult<FindingSummary>, Error>;

const NO_CARDS: readonly FindingSummary[] = [];

function toColumn(status: FindingStatus, query: ColumnQuery, hydrated: boolean): ColumnData {
  return {
    status,
    cards: hydrated ? (query.data?.items ?? NO_CARDS) : NO_CARDS,
    total: hydrated ? (query.data?.total ?? null) : null,
    isPending: !hydrated || query.isPending,
    isFetching: hydrated && query.isFetching,
    isFetchingNextPage: query.isFetchingNextPage,
    hasNextPage: hydrated && query.hasNextPage,
    error: hydrated ? query.error : null,
    retry: () => void query.refetch(),
    loadMore: () => void query.fetchNextPage(),
  };
}

export function useBoardColumns(targetId: string, filters: FindingBoardFilters): BoardColumns {
  const hydrated = useHydrated();
  const created = useInfiniteQuery(findingsColumnQuery(targetId, filters, "new"));
  const triaged = useInfiniteQuery(findingsColumnQuery(targetId, filters, "triaged"));
  const inFix = useInfiniteQuery(findingsColumnQuery(targetId, filters, "in_fix"));
  const verifying = useInfiniteQuery(findingsColumnQuery(targetId, filters, "verifying"));
  const resolved = useInfiniteQuery(findingsColumnQuery(targetId, filters, "resolved"));
  const knownGap = useInfiniteQuery(findingsColumnQuery(targetId, filters, "known_gap"));
  const dismissed = useInfiniteQuery(findingsColumnQuery(targetId, filters, "dismissed"));
  return {
    new: toColumn("new", created, hydrated),
    triaged: toColumn("triaged", triaged, hydrated),
    in_fix: toColumn("in_fix", inFix, hydrated),
    verifying: toColumn("verifying", verifying, hydrated),
    resolved: toColumn("resolved", resolved, hydrated),
    known_gap: toColumn("known_gap", knownGap, hydrated),
    dismissed: toColumn("dismissed", dismissed, hydrated),
  };
}
