import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import type { Proposal } from "./types";

export const PROPOSAL_STALE_TIME_MS = 15_000;

export function proposalQuery(targetId: string) {
  return queryOptions({
    queryKey: qk.proposals.current(targetId),
    queryFn: async ({ signal }): Promise<Proposal | null> => {
      try {
        return await unwrap(
          api.GET("/api/v1/targets/{target_id}/proposal", {
            params: { path: { target_id: targetId } },
            signal,
          }),
        );
      } catch (error) {
        if (isApiError(error) && error.status === 404) {
          return null;
        }
        throw error;
      }
    },
    staleTime: PROPOSAL_STALE_TIME_MS,
    meta: INLINE_ERROR_META,
  });
}
