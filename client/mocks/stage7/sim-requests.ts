import { validationFailed } from "../factories/errors";
import { BodyReader, type Source } from "../stage1/body";
import { parseBudget, PLAN_MAX_K } from "../stage2/plan-service";
import type { ErrorDetail } from "../types";
import type { Budget, GoalKind } from "@/lib/api/types";

export const GOAL_KINDS = [
  "reach_state",
  "extract_fact",
  "attempt_forbidden",
  "complete_flow",
] as const satisfies readonly GoalKind[];

export const PERSONA_NAME_MAX = 120;
export const PERSONA_DESCRIPTION_MAX = 2000;
export const TRAITS_JSON_MAX = 4000;
export const GOAL_TITLE_MAX = 120;
export const GOAL_STATEMENT_MAX = 2000;
export const GOAL_ROLE_MAX = 80;
export const GOAL_CRITERIA_MAX = 20;
export const SEARCH_MAX = 200;

const CRITERION_PATTERN_SOURCE = "^(?!(?:db|tool|text|judge):\\s*$)\\S";
const CRITERION_PATTERN = new RegExp(CRITERION_PATTERN_SOURCE, "u");

export interface PersonaFields {
  name: string;
  description: string;
  traits: Source;
}

export interface GoalFields {
  title: string;
  kind: GoalKind;
  statement: string;
  role: string | null;
  success_criteria: string[];
}

export interface SimulationRequestBody {
  targetId: string;
  personaId: string;
  goalId: string;
  role: string;
  k: number;
  budget: Budget;
}

function rejectUnknownKeys(raw: Source, allowed: readonly string[], reader: BodyReader): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      reader.issue(key, "extra_forbidden", "Extra inputs are not permitted");
    }
  }
}

function throwIfAny(details: ErrorDetail[]): void {
  if (details.length > 0) {
    throw validationFailed(details);
  }
}

function checkTraits(reader: BodyReader, traits: Source | null | undefined): void {
  if (traits !== null && traits !== undefined && JSON.stringify(traits).length > TRAITS_JSON_MAX) {
    reader.issue(
      "traits",
      "too_long",
      `Traits should be at most ${TRAITS_JSON_MAX} characters as JSON`,
    );
  }
}

export function parsePersonaCreate(raw: Source): PersonaFields & { target_id: string } {
  const reader = new BodyReader(raw);
  rejectUnknownKeys(raw, ["target_id", "name", "description", "traits"], reader);
  const targetId = reader.uuid("target_id", { required: true });
  const name = reader.string("name", { required: true, min: 1, max: PERSONA_NAME_MAX, strip: true });
  const description = reader.string("description", {
    required: true,
    min: 1,
    max: PERSONA_DESCRIPTION_MAX,
    strip: true,
  });
  const traits = reader.object("traits", {});
  if (!reader.has("traits")) {
    reader.issue("traits", "missing", "Field required");
  }
  checkTraits(reader, traits);
  throwIfAny(reader.details);
  return {
    target_id: targetId as string,
    name: name as string,
    description: description as string,
    traits: traits as Source,
  };
}

export function parsePersonaUpdate(raw: Source): Partial<PersonaFields> {
  const reader = new BodyReader(raw);
  rejectUnknownKeys(raw, ["name", "description", "traits"], reader);
  const name = reader.string("name", {
    required: false,
    nullable: true,
    min: 1,
    max: PERSONA_NAME_MAX,
    strip: true,
  });
  const description = reader.string("description", {
    required: false,
    nullable: true,
    min: 1,
    max: PERSONA_DESCRIPTION_MAX,
    strip: true,
  });
  const traits = reader.object("traits", { nullable: true });
  checkTraits(reader, traits);
  throwIfAny(reader.details);
  const change: Partial<PersonaFields> = {};
  if (typeof name === "string") {
    change.name = name;
  }
  if (typeof description === "string") {
    change.description = description;
  }
  if (traits !== null && traits !== undefined) {
    change.traits = traits;
  }
  return change;
}

function checkCriteria(reader: BodyReader, criteria: string[] | null | undefined, required: boolean) {
  if (criteria === null || criteria === undefined) {
    if (required && !reader.has("success_criteria")) {
      reader.issue("success_criteria", "missing", "Field required");
    }
    return;
  }
  if (criteria.length < 1) {
    reader.issue("success_criteria", "too_short", "List should have at least 1 item after validation, not 0");
  }
  if (criteria.length > GOAL_CRITERIA_MAX) {
    reader.issue(
      "success_criteria",
      "too_long",
      `List should have at most ${GOAL_CRITERIA_MAX} items after validation, not ${criteria.length}`,
    );
  }
  criteria.forEach((entry, index) => {
    if (!CRITERION_PATTERN.test(entry)) {
      reader.details.push({
        loc: ["body", "success_criteria", index],
        code: "string_pattern_mismatch",
        message: `String should match pattern '${CRITERION_PATTERN_SOURCE}'`,
      });
    }
  });
}

export function parseGoalCreate(raw: Source): GoalFields & { target_id: string } {
  const reader = new BodyReader(raw);
  rejectUnknownKeys(
    raw,
    ["target_id", "title", "kind", "statement", "success_criteria", "role"],
    reader,
  );
  const targetId = reader.uuid("target_id", { required: true });
  const title = reader.string("title", { required: true, min: 1, max: GOAL_TITLE_MAX, strip: true });
  const kind = reader.enum("kind", GOAL_KINDS, { required: true });
  const statement = reader.string("statement", {
    required: true,
    min: 1,
    max: GOAL_STATEMENT_MAX,
    strip: true,
  });
  const role = reader.string("role", {
    required: false,
    nullable: true,
    min: 1,
    max: GOAL_ROLE_MAX,
    strip: true,
  });
  const criteria = reader.stringList("success_criteria", { nullable: false });
  checkCriteria(reader, criteria, true);
  throwIfAny(reader.details);
  return {
    target_id: targetId as string,
    title: title as string,
    kind: kind as GoalKind,
    statement: statement as string,
    role: typeof role === "string" ? role : null,
    success_criteria: criteria as string[],
  };
}

export interface GoalChange {
  title?: string;
  kind?: GoalKind;
  statement?: string;
  role?: string | null;
  success_criteria?: string[];
}

export function parseGoalUpdate(raw: Source): GoalChange {
  const reader = new BodyReader(raw);
  rejectUnknownKeys(raw, ["title", "kind", "statement", "success_criteria", "role"], reader);
  const title = reader.string("title", {
    required: false,
    nullable: true,
    min: 1,
    max: GOAL_TITLE_MAX,
    strip: true,
  });
  const kind = reader.enum("kind", GOAL_KINDS, { required: false, nullable: true });
  const statement = reader.string("statement", {
    required: false,
    nullable: true,
    min: 1,
    max: GOAL_STATEMENT_MAX,
    strip: true,
  });
  const role = reader.string("role", {
    required: false,
    nullable: true,
    min: 1,
    max: GOAL_ROLE_MAX,
    strip: true,
  });
  const criteria = reader.stringList("success_criteria", { nullable: true });
  checkCriteria(reader, criteria, false);
  throwIfAny(reader.details);
  const change: GoalChange = {};
  if (typeof title === "string") {
    change.title = title;
  }
  if (typeof kind === "string") {
    change.kind = kind;
  }
  if (typeof statement === "string") {
    change.statement = statement;
  }
  if (reader.has("role")) {
    change.role = typeof role === "string" ? role : null;
  }
  if (Array.isArray(criteria)) {
    change.success_criteria = criteria;
  }
  return change;
}

export function parseSimulationCreate(raw: Source): SimulationRequestBody {
  const reader = new BodyReader(raw);
  rejectUnknownKeys(raw, ["target_id", "persona_id", "goal_id", "role", "k", "budget"], reader);
  const targetId = reader.uuid("target_id", { required: true });
  const personaId = reader.uuid("persona_id", { required: true });
  const goalId = reader.uuid("goal_id", { required: true });
  const role = reader.string("role", { required: true, min: 1, max: GOAL_ROLE_MAX, strip: true });
  const k = raw.k;
  let attempts: number | undefined;
  if (k === undefined) {
    reader.issue("k", "missing", "Field required");
  } else if (typeof k !== "number" || !Number.isInteger(k)) {
    reader.issue("k", "int_type", "Input should be a valid integer");
  } else if (k < 1) {
    reader.issue("k", "greater_than_equal", "Input should be greater than or equal to 1");
  } else if (k > PLAN_MAX_K) {
    reader.issue("k", "less_than_equal", `Input should be less than or equal to ${PLAN_MAX_K}`);
  } else {
    attempts = k;
  }
  const budget = parseBudget(raw.budget, ["body", "budget"], reader.details);
  if (raw.budget === undefined || raw.budget === null) {
    reader.issue("budget", "missing", "Field required");
  }
  throwIfAny(reader.details);
  return {
    targetId: targetId as string,
    personaId: personaId as string,
    goalId: goalId as string,
    role: role as string,
    k: attempts as number,
    budget: budget as Budget,
  };
}
