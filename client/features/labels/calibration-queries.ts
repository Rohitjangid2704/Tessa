import { queryOptions } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import type { CalibrationReport } from "@/lib/api/types";
import { unwrap } from "@/lib/api/unwrap";

export const CALIBRATION_STALE_TIME_MS = 30_000;

export function calibrationReportQuery(targetId: string | null) {
  return queryOptions({
    queryKey: qk.calibration.report(targetId),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET("/api/v1/calibration", {
          params: { query: targetId === null ? {} : { target_id: targetId } },
          signal,
        }),
      ),
    staleTime: CALIBRATION_STALE_TIME_MS,
    meta: INLINE_ERROR_META,
  });
}

export function totalCalibrationLabels(report: Pick<CalibrationReport, "items">): number {
  return report.items.reduce((sum, item) => sum + item.n_labels, 0);
}
