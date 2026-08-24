import { z } from "zod";
import type { Run } from "@/lib/api/types";

const subsetScenarioIdsSchema = z.array(z.string().min(1)).min(1);

export function subsetScenarioIds(run: Pick<Run, "config_snapshot">): string[] | null {
  const parsed = subsetScenarioIdsSchema.safeParse(
    (run.config_snapshot as Record<string, unknown>).scenario_ids,
  );
  return parsed.success ? parsed.data : null;
}
