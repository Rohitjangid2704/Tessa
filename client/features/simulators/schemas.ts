import { z } from "zod";
import {
  createSearchParamsCodec,
  enumListParam,
  enumParam,
  textParam,
} from "@/lib/search-params";
import type { SimulatorTab } from "@/lib/routes";
import type { GoalKind, SimChecks } from "./types";

export const SIMULATOR_TABS = [
  "personas",
  "goals",
  "simulations",
] as const satisfies readonly SimulatorTab[];

export const SIMULATOR_TAB_LABELS: Record<SimulatorTab, string> = {
  personas: "Personas",
  goals: "Goals",
  simulations: "Simulations",
};

export const DEFAULT_SIMULATOR_TAB: SimulatorTab = "personas";

export const GOAL_KINDS = [
  "reach_state",
  "extract_fact",
  "attempt_forbidden",
  "complete_flow",
] as const satisfies readonly GoalKind[];

export const GOAL_KIND_LABELS: Record<GoalKind, string> = {
  reach_state: "Reach a state",
  extract_fact: "Extract a fact",
  attempt_forbidden: "Attempt something forbidden",
  complete_flow: "Complete a flow",
};

export const GOAL_KIND_HELP: Record<GoalKind, string> = {
  reach_state: "Get the app into a target state, such as a confirmed request.",
  extract_fact: "Get the assistant to state one specific fact.",
  attempt_forbidden: "Try an action this role must not be allowed to do.",
  complete_flow: "Finish a multi-step flow from the first step to the last.",
};

export const SIM_CHECKS = [
  "end_state",
  "calls",
  "invariants",
  "goal",
  "dialogue",
] as const satisfies readonly (keyof SimChecks)[];

export interface SimCheckInfo {
  label: string;
  description: string;
  decidedBy: "code" | "judge";
}

export const SIM_CHECK_INFO: Record<keyof SimChecks, SimCheckInfo> = {
  end_state: {
    label: "End state",
    description: "The data the target ends up with, compared with the goal by code.",
    decidedBy: "code",
  },
  calls: {
    label: "Calls",
    description: "The tool calls the target made, compared with the goal by code.",
    decidedBy: "code",
  },
  invariants: {
    label: "Invariants",
    description: "Rules that must always hold, such as never revealing another guest's data.",
    decidedBy: "code",
  },
  goal: {
    label: "Goal",
    description: "Whether the success criteria of the goal that code can decide were met.",
    decidedBy: "code",
  },
  dialogue: {
    label: "Dialogue",
    description: "Whether the conversation stayed natural and in character, decided by the judge.",
    decidedBy: "judge",
  },
};

export const MAX_ATTEMPTS = 10;
export const MIN_ATTEMPTS = 1;
export const DEFAULT_ATTEMPTS = 3;
export const GUID_LENGTH = 36;
export const SIMULATOR_PAGE_SIZE = 25;
export const SESSION_PAGE_SIZE = 50;
export const OPTIONS_PAGE_SIZE = 200;
export const PERSONA_NAME_MAX = 120;
export const GOAL_TITLE_MAX = 120;

export const PERSONA_SCHEMA_NAME = "persona";
export const GOAL_SCHEMA_NAME = "goal";
export const SCHEMA_VERSION = 1;

export const simulatorsCodec = createSearchParamsCodec({
  tab: enumParam(SIMULATOR_TABS),
  q: textParam(),
  kind: enumListParam(GOAL_KINDS),
  session: textParam(GUID_LENGTH),
});

export type SimulatorFilterValues = ReturnType<typeof simulatorsCodec.parse>;

const idSchema = z.guid();

export function readSessionId(value: string | undefined): string | null {
  const parsed = idSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const simulationFormSchema = z.object({
  persona_id: z.guid("Choose a persona"),
  goal_id: z.guid("Choose a goal"),
  role: z.string().trim().min(1, "Choose a role").max(80),
  k: z
    .number("Enter a whole number of attempts")
    .int("Enter a whole number of attempts")
    .min(MIN_ATTEMPTS, `Use at least ${MIN_ATTEMPTS} attempt`)
    .max(MAX_ATTEMPTS, `Use at most ${MAX_ATTEMPTS} attempts`),
});

export type SimulationFormValues = z.infer<typeof simulationFormSchema>;

export interface SimulationDraft {
  personaId: string;
  goalId: string;
  role: string;
  attempts: string;
}

const WHOLE_NUMBER = /^\d+$/;

export function resolveSimulationDraft(
  draft: SimulationDraft,
): { values: SimulationFormValues } | { errors: Partial<Record<keyof SimulationFormValues, string>> } {
  const attempts = draft.attempts.trim();
  const parsed = simulationFormSchema.safeParse({
    persona_id: draft.personaId,
    goal_id: draft.goalId,
    role: draft.role,
    k: WHOLE_NUMBER.test(attempts) ? Number(attempts) : Number.NaN,
  });
  if (parsed.success) {
    return { values: parsed.data };
  }
  const errors: Partial<Record<keyof SimulationFormValues, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (typeof field === "string" && field in simulationFormSchema.shape) {
      errors[field as keyof SimulationFormValues] ??= issue.message;
    }
  }
  return { errors };
}
