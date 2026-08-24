import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import type { InvariantPack, Probe } from "@/lib/api/types";
import { unwrap } from "@/lib/api/unwrap";

export const PROBE_BANK_PAGE_SIZE = 200;
export const PROBE_BANK_STALE_TIME_MS = 5 * 60_000;

export interface ProbeFilters {
  packs?: InvariantPack[];
  q?: string;
}

export function probesQuery(filters: ProbeFilters = {}) {
  return queryOptions({
    queryKey: qk.probes(filters),
    staleTime: PROBE_BANK_STALE_TIME_MS,
    meta: INLINE_ERROR_META,
    queryFn: async ({ signal }): Promise<Probe[]> => {
      const page = await unwrap(
        api.GET("/api/v1/probes", {
          params: {
            query: { pack: filters.packs, q: filters.q, limit: PROBE_BANK_PAGE_SIZE },
          },
          signal,
        }),
      );
      return page.items;
    },
  });
}

export function useProbeBank() {
  const query = useQuery(probesQuery());
  const byId = new Map((query.data ?? []).map((probe) => [probe.id, probe]));
  return {
    byId,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}
