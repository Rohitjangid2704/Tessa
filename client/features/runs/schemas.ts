import { RUN_STATUSES, VERDICT_STATUSES } from "@/components/status/status-types";
import { targetIdParam } from "@/features/targets/target-id-param";
import { createSearchParamsCodec, enumListParam, stringListParam } from "@/lib/search-params";
import { RUN_KINDS, RUN_SCENARIO_STATUSES } from "./labels";

export const runFiltersCodec = createSearchParamsCodec({
  target_id: targetIdParam(),
  status: enumListParam(RUN_STATUSES),
  kind: enumListParam(RUN_KINDS),
});

export type RunFilterValues = ReturnType<typeof runFiltersCodec.parse>;

export const runScenarioFiltersCodec = createSearchParamsCodec({
  status: enumListParam(RUN_SCENARIO_STATUSES),
  verdict: enumListParam(VERDICT_STATUSES),
  family: stringListParam(),
  role: stringListParam(),
});

export type RunScenarioFilterValues = ReturnType<typeof runScenarioFiltersCodec.parse>;
