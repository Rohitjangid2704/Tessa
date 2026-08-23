import type { UseQueryResult } from "@tanstack/react-query";
import type { DashboardSummary } from "@/lib/api/types";
import type { KpiTileLoadState } from "./components/kpi-tile";

export type DashboardQueryResult = UseQueryResult<DashboardSummary, Error>;

export interface LoadSource {
  isPending: boolean;
  error: unknown;
  refetch: () => unknown;
}

export function loadStateOf(query: LoadSource): KpiTileLoadState {
  return {
    isPending: query.isPending,
    error: query.error,
    onRetry: () => void query.refetch(),
  };
}
