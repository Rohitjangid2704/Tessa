import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { isRunTerminal } from "@/lib/api/polling";
import { qk } from "@/lib/api/query-keys";
import { seedRunQuery } from "./queries";

export function useSeedRun(runId: string | null) {
  const queryClient = useQueryClient();
  const query = useQuery({ ...seedRunQuery(runId ?? ""), enabled: runId !== null });
  const run = query.data;
  const isSeedRun = run !== undefined && run.kind === "seed";
  const settled = run !== undefined && isRunTerminal(run);
  const starting = runId !== null && query.isPending;

  useEffect(() => {
    if (settled) {
      void queryClient.invalidateQueries({ queryKey: qk.seeds.all() });
    }
  }, [settled, runId, queryClient]);

  return {
    query,
    run: isSeedRun ? run : undefined,
    notASeedRun: run !== undefined && !isSeedRun,
    active: starting || (isSeedRun && !settled),
    settled: isSeedRun && settled,
  };
}
