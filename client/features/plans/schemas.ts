import { z } from "zod";
import { createSearchParamsCodec, enumParam, uuidParam } from "@/lib/search-params";

export const PLAN_K_MIN = 1;
export const PLAN_K_MAX = 10;
export const PLAN_NAME_MAX_LENGTH = 120;
export const PREVIEW_DEBOUNCE_MS = 300;
export const PREVIEW_STALE_TIME_MS = 30_000;
export const SAVED_PLANS_PAGE_SIZE = 25;
export const DEFAULT_PLAN_NAME_PLACEHOLDER = "Smoke run of the guest features";

export const kSchema = z.number().int().min(PLAN_K_MIN).max(PLAN_K_MAX);
export const maxUsdSchema = z.number().positive();
export const maxMinutesSchema = z.number().int().min(1);
export const budgetSchema = z.object({ max_usd: maxUsdSchema, max_minutes: maxMinutesSchema });

export const planBuilderSchema = z.object({
  k: kSchema,
  budget: budgetSchema.optional(),
});

export const planNameSchema = z
  .string()
  .trim()
  .min(1, "Give the plan a name")
  .max(PLAN_NAME_MAX_LENGTH, `Use at most ${PLAN_NAME_MAX_LENGTH} characters`);

export function clampAttempts(value: number): number {
  if (!Number.isFinite(value)) {
    return PLAN_K_MIN;
  }
  return Math.min(PLAN_K_MAX, Math.max(PLAN_K_MIN, Math.round(value)));
}

export const WORKSPACE_TABS = ["catalog", "plans"] as const;

export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

export const DEFAULT_WORKSPACE_TAB: WorkspaceTab = "catalog";

const LEGACY_TAB_VALUES: Readonly<Record<string, WorkspaceTab>> = { saved: "plans" };

function canonicalTabValues(raw: unknown): unknown {
  if (!Array.isArray(raw)) {
    return raw;
  }
  return raw.map((value: unknown) =>
    typeof value === "string" ? (LEGACY_TAB_VALUES[value] ?? value) : value,
  );
}

export const workspaceTabCodec = createSearchParamsCodec({
  tab: z.preprocess(canonicalTabValues, enumParam(WORKSPACE_TABS)),
});

export function isWorkspaceTab(value: string): value is WorkspaceTab {
  return (WORKSPACE_TABS as readonly string[]).includes(value);
}

export const PLAN_PARAM = "plan";

export const requestedPlanCodec = createSearchParamsCodec({
  [PLAN_PARAM]: uuidParam(),
});
