import { queryOptions, skipToken } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import type { RunDiff, RunSummary } from "@/lib/api/types";

export const RUN_DIFF_PICKER_PAGE_SIZE = 50;

export function runDiffQuery(runId: string, against: string | null) {
  return queryOptions({
    queryKey: qk.runs.diff(runId, against),
    queryFn:
      against === null
        ? skipToken
        : ({ signal }) =>
            unwrap(
              api.GET("/api/v1/runs/{run_id}/diff", {
                params: { path: { run_id: runId }, query: { against } },
                signal,
              }),
            ),
  });
}

export function isIdenticalDiff(diff: RunDiff): boolean {
  return diff.items.every((item) => item.category === "unchanged");
}

export function olderRunsOf(
  runs: readonly RunSummary[],
  current: Pick<RunSummary, "id" | "created_at">,
): RunSummary[] {
  const currentMs = Date.parse(current.created_at);
  return runs.filter((run) => run.id !== current.id && Date.parse(run.created_at) < currentMs);
}
