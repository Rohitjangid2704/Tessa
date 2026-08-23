import { z } from "zod";
import { SEVERITIES } from "@/components/status/status-types";
import { isTargetId } from "@/features/targets/current-target";
import type { FindingClass, Severity } from "@/lib/api/types";
import {
  createSearchParamsCodec,
  enumListParam,
  stringListParam,
  textParam,
} from "@/lib/search-params";
import { FINDING_STATUSES } from "./detail-schemas";
import { FINDING_CLASSES } from "./labels";

function uuidParam() {
  return z.preprocess((raw) => {
    const value: unknown = Array.isArray(raw) ? raw[0] : undefined;
    const trimmed = typeof value === "string" ? value.trim() : "";
    return isTargetId(trimmed) ? trimmed.toLowerCase() : undefined;
  }, z.string().optional());
}

export const findingFiltersCodec = createSearchParamsCodec({
  status: enumListParam(FINDING_STATUSES),
  severity: enumListParam(SEVERITIES),
  class: enumListParam(FINDING_CLASSES),
  invariant_id: stringListParam(),
  run_id: uuidParam(),
  q: textParam(),
});

export type FindingFilterValues = ReturnType<typeof findingFiltersCodec.parse>;

export interface FindingBoardFilters {
  severity?: Severity[];
  class?: FindingClass[];
  invariant_id?: string[];
  run_id?: string;
  q?: string;
}

export function toBoardFilters(values: FindingFilterValues): FindingBoardFilters {
  return {
    severity: values.severity,
    class: values.class,
    invariant_id: values.invariant_id,
    run_id: values.run_id,
    q: values.q,
  };
}
