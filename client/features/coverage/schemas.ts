import { z } from "zod";
import { budgetSchema } from "@/features/plans/schemas";
import {
  createSearchParamsCodec,
  enumListParam,
  stringListParam,
  textParam,
} from "@/lib/search-params";
import { CELL_STATUSES, DEPTHS } from "./labels";

export const COVERAGE_REFETCH_THROTTLE_MS = 1000;
export const VIRTUALIZE_ROW_THRESHOLD = 200;
export const AUTHOR_PROMPT_WARN_BYTES = 100 * 1024;
export const COVERAGE_SCENARIOS_PAGE_SIZE = 50;
export const ACTIVE_GENERATION_RUN_LIMIT = 5;

export const coverageFiltersCodec = createSearchParamsCodec({
  plan_id: textParam(64),
  area: stringListParam(),
  status: enumListParam(CELL_STATUSES),
});

export type CoverageFilterValues = ReturnType<typeof coverageFiltersCodec.parse>;

export const generateFormSchema = z.object({
  plan_id: z.uuid(),
  cell_ids: z.array(z.uuid()).min(1, "Pick at least one cell"),
  depth: z.enum(DEPTHS),
  budget: budgetSchema.optional(),
});

export type GenerateFormValues = z.infer<typeof generateFormSchema>;
