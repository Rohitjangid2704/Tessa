import { z } from "zod";
import { GOAL_KINDS } from "@/features/simulators/schemas";
import type { Budget, ExplorationCreate, GoalKind } from "@/lib/api/types";

export const GOAL_TEXT_MAX_LENGTH = 2000;
export const DEFAULT_GOAL_KIND: GoalKind = "attempt_forbidden";
export const MAX_STEPS_MIN = 1;

export const GOAL_MODES = ["text", "saved"] as const;

export type GoalMode = (typeof GOAL_MODES)[number];

export const DEFAULT_GOAL_MODE: GoalMode = "text";

const WHOLE_NUMBER = /^\d+$/;

export const explorationFormSchema = z
  .object({
    role: z.string().trim().min(1, "Choose the role the explorer plays"),
    goal_mode: z.enum(GOAL_MODES),
    goal_id: z.string(),
    goal_text: z
      .string()
      .max(GOAL_TEXT_MAX_LENGTH, `Use at most ${GOAL_TEXT_MAX_LENGTH} characters`),
    goal_kind: z.enum(GOAL_KINDS),
    max_steps: z
      .string()
      .trim()
      .refine(
        (value) => value === "" || (WHOLE_NUMBER.test(value) && Number(value) >= MAX_STEPS_MIN),
        `Enter a whole number of steps, ${MAX_STEPS_MIN} or more, or leave it empty`,
      ),
  })
  .superRefine((values, context) => {
    const savedGoal = values.goal_mode === "saved" ? values.goal_id.trim() : "";
    const goalText = values.goal_mode === "text" ? values.goal_text.trim() : "";
    const filled = [savedGoal, goalText].filter((value) => value !== "").length;
    if (filled === 1) {
      return;
    }
    context.addIssue({
      code: "custom",
      path: [values.goal_mode === "saved" ? "goal_id" : "goal_text"],
      message:
        values.goal_mode === "saved"
          ? "Choose a saved goal, or describe one instead"
          : "Describe what the explorer should try, or choose a saved goal",
    });
  });

export type ExplorationFormValues = z.infer<typeof explorationFormSchema>;

export const EXPLORATION_FORM_FIELDS = [
  "role",
  "goal_id",
  "goal_text",
  "goal_kind",
  "max_steps",
] as const;

export function defaultExplorationValues(): ExplorationFormValues {
  return {
    role: "",
    goal_mode: DEFAULT_GOAL_MODE,
    goal_id: "",
    goal_text: "",
    goal_kind: DEFAULT_GOAL_KIND,
    max_steps: "",
  };
}

export function toExplorationCreate(
  values: ExplorationFormValues,
  targetId: string,
  budget: Budget,
): ExplorationCreate {
  const goal =
    values.goal_mode === "saved"
      ? { goal_id: values.goal_id.trim() }
      : { goal_text: values.goal_text.trim(), goal_kind: values.goal_kind };
  const maxSteps = values.max_steps.trim();
  return {
    target_id: targetId,
    role: values.role.trim(),
    ...goal,
    ...(maxSteps === "" ? {} : { max_steps: Number(maxSteps) }),
    budget,
  };
}

export function hasExactlyOneGoal(body: Pick<ExplorationCreate, "goal_id" | "goal_text">): boolean {
  const hasId = body.goal_id !== undefined && body.goal_id !== null && body.goal_id !== "";
  const hasText = body.goal_text !== undefined && body.goal_text !== null && body.goal_text !== "";
  return hasId !== hasText;
}
