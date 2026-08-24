import { z } from "zod";
import type { RunDetailTab } from "@/lib/routes";
import { createSearchParamsCodec, enumParam } from "@/lib/search-params";

export const RUN_TABS = ["live", "scenarios", "results"] as const satisfies readonly RunDetailTab[];

export const RUN_TAB_LABELS = {
  live: "Live",
  scenarios: "Scenarios",
  results: "Results",
} as const satisfies Record<RunDetailTab, string>;

export const RUN_TAB_KEPT_MOUNTED = {
  live: true,
  scenarios: true,
  results: false,
} as const satisfies Record<RunDetailTab, boolean>;

export const runTabCodec = createSearchParamsCodec({ tab: enumParam(RUN_TABS) });

export function readRunTab(value: string): RunDetailTab | undefined {
  return RUN_TABS.find((tab) => tab === value);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidParam() {
  return z.preprocess((raw) => {
    const value: unknown = Array.isArray(raw) ? raw[0] : undefined;
    return typeof value === "string" && UUID_PATTERN.test(value) ? value : undefined;
  }, z.string().optional());
}

export const runDiffCodec = createSearchParamsCodec({ against: uuidParam() });

export type RunDiffParams = ReturnType<typeof runDiffCodec.parse>;
