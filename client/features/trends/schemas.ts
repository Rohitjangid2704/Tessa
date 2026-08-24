import { z } from "zod";
import { createSearchParamsCodec, enumParam } from "@/lib/search-params";
import { DEFAULT_TREND_RANGE_DAYS, TREND_RANGE_DAYS, type TrendRangeDays } from "./queries";

export const RUNS_TABS = ["runs", "trends"] as const;

export type RunsTab = (typeof RUNS_TABS)[number];

export const runsTabCodec = createSearchParamsCodec({ tab: enumParam(RUNS_TABS) });

const RANGE_VALUES = ["7", "30", "90"] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function planIdParam() {
  return z.preprocess((raw) => {
    const value: unknown = Array.isArray(raw) ? raw[0] : undefined;
    return typeof value === "string" && UUID_PATTERN.test(value) ? value : undefined;
  }, z.string().optional());
}

export const trendFiltersCodec = createSearchParamsCodec({
  range: enumParam(RANGE_VALUES),
  plan_id: planIdParam(),
});

export type TrendFilterValues = ReturnType<typeof trendFiltersCodec.parse>;

export function rangeDaysOf(value: TrendFilterValues["range"]): TrendRangeDays {
  const parsed = TREND_RANGE_DAYS.find((days) => String(days) === value);
  return parsed ?? DEFAULT_TREND_RANGE_DAYS;
}
