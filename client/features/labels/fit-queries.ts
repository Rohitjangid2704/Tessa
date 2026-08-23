import {
  queryOptions,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "@/lib/api/client";
import { polling } from "@/lib/api/polling";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import type { CalibrationFit } from "@/lib/api/types";
import { unwrap } from "@/lib/api/unwrap";

export type CalibrationFitQueryResult = UseQueryResult<CalibrationFit, unknown>;

export function calibrationFitQuery(runId: string) {
  return queryOptions({
    queryKey: qk.calibration.fit(runId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/calibration/fit/{run_id}", {
          params: { path: { run_id: runId } },
          signal,
        }),
      ),
    meta: INLINE_ERROR_META,
    ...polling.run,
  });
}

export function useCalibrationFit(runId: string | null) {
  const queryClient = useQueryClient();
  const query = useQuery({ ...calibrationFitQuery(runId ?? ""), enabled: runId !== null });
  const fit = query.data;
  const adoptedByServer = fit !== undefined && fit.status === "completed" && fit.adopted;

  useEffect(() => {
    if (adoptedByServer) {
      void queryClient.invalidateQueries({ queryKey: qk.settings() });
    }
  }, [adoptedByServer, queryClient]);

  return query;
}
