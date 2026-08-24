import { z } from "zod";
import { targetIdParam } from "@/features/targets/target-id-param";
import { clientEnv } from "@/lib/env.client";
import {
  booleanParam,
  createSearchParamsCodec,
  enumListParam,
  sortParam,
  textParam,
  uuidParam,
} from "@/lib/search-params";
import {
  DEFAULT_SCENARIO_SORT,
  SCENARIO_ORIGINS,
  SCENARIO_SORT_KEYS,
  SCENARIO_STATUSES,
} from "./labels";

export const SCENARIO_SCHEMA_URL = `${clientEnv.NEXT_PUBLIC_API_URL}/schemas/scenario.v1.json`;

export const SCENARIO_YAML_MAX_LENGTH = 200_000;

export const REVIEW_NOTE_MAX_LENGTH = 2000;

export const reviewFiltersCodec = createSearchParamsCodec({
  target_id: targetIdParam(),
  origin: enumListParam(SCENARIO_ORIGINS),
  scenario: textParam(),
  replay_id: uuidParam(),
});

export type ReviewFilterValues = ReturnType<typeof reviewFiltersCodec.parse>;

export const reviewFormSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("accept") }),
  z.object({
    decision: z.literal("reject"),
    note: z
      .string()
      .trim()
      .min(1, "Say why this scenario is rejected")
      .max(REVIEW_NOTE_MAX_LENGTH, `Keep the note under ${REVIEW_NOTE_MAX_LENGTH} characters`),
  }),
]);

export const newScenarioSchema = z.object({
  target_id: z.string().min(1, "Choose a target"),
  yaml: z
    .string()
    .trim()
    .min(1, "Write the scenario YAML")
    .max(SCENARIO_YAML_MAX_LENGTH, "The scenario YAML is too long"),
});

export const scenarioFiltersCodec = createSearchParamsCodec(
  {
    target_id: targetIdParam(),
    q: textParam(),
    status: enumListParam(SCENARIO_STATUSES),
    origin: enumListParam(SCENARIO_ORIGINS),
    family: textParam(),
    feature_id: textParam(),
    include_synthetic: booleanParam(),
    sort: sortParam(SCENARIO_SORT_KEYS),
  },
  { defaults: { include_synthetic: false, sort: DEFAULT_SCENARIO_SORT } },
);

export type ScenarioFilterValues = ReturnType<typeof scenarioFiltersCodec.parse>;
