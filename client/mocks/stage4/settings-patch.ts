import type { ErrorDetail } from "../types";
import {
  EFFORTS,
  EMAIL_MAX_ITEMS,
  EMAIL_MAX_LENGTH,
  EMAIL_PATTERN,
  MODEL_LEAVES,
  MODEL_MAX_LENGTH,
  MODEL_PATTERN,
  MODEL_ROLES,
  SETTINGS_GROUPS,
  URL_MAX_LENGTH,
  type ModelLeaf,
  type SettingsGroupName,
} from "./settings-spec";

export type LeafValue = string | number | boolean | string[];

export interface ParsedLeaf {
  path: readonly string[];
  value: LeafValue | null;
}

export interface ParsedSettingsPatch {
  leaves: ParsedLeaf[];
  details: ErrorDetail[];
}

type LeafRule =
  | { kind: "model" }
  | { kind: "effort" }
  | { kind: "number"; exclusiveMin?: number; min?: number; max?: number }
  | { kind: "integer"; min: number; max?: number }
  | { kind: "url" }
  | { kind: "boolean" }
  | { kind: "emails" };

interface LeafProblem {
  code: string;
  message: string;
  index?: number;
}

const MODEL_LEAF_RULES: Record<ModelLeaf, LeafRule> = {
  model: { kind: "model" },
  effort: { kind: "effort" },
  max_usd: { kind: "number", min: 0 },
  timeout_seconds: { kind: "integer", min: 1 },
};

const FLAT_LEAF_RULES: Record<Exclude<SettingsGroupName, "models">, Record<string, LeafRule>> = {
  thresholds: {
    probe_confidence: { kind: "number", min: 0, max: 1 },
    judge_escalate_below: { kind: "number", min: 0, max: 1 },
    label_audit_rate: { kind: "number", min: 0, max: 1 },
  },
  endpoints: {
    laya_url: { kind: "url" },
    jev_url: { kind: "url" },
  },
  budgets: {
    default_max_usd: { kind: "number", exclusiveMin: 0 },
    default_max_minutes: { kind: "integer", min: 1 },
    max_concurrency: { kind: "integer", min: 1 },
  },
  notifications: {
    slack_enabled: { kind: "boolean" },
    email_to: { kind: "emails" },
  },
  policies: {
    flaky_quarantine_after: { kind: "integer", min: 1 },
  },
};

function joinOptions(options: readonly string[]): string {
  const quoted = options.map((option) => `'${option}'`);
  const last = quoted[quoted.length - 1] ?? "";
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} or ${last}` : last;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkModel(value: unknown): LeafProblem | null {
  if (typeof value !== "string") {
    return { code: "string_type", message: "Input should be a valid string" };
  }
  if (value.trim().length < 1) {
    return { code: "string_too_short", message: "String should have at least 1 character" };
  }
  if (value.length > MODEL_MAX_LENGTH) {
    return {
      code: "string_too_long",
      message: `String should have at most ${MODEL_MAX_LENGTH} characters`,
    };
  }
  if (!MODEL_PATTERN.test(value)) {
    return {
      code: "invalid_model",
      message: "Model names use letters, digits, dot, dash, underscore, colon and slash only",
    };
  }
  return null;
}

function checkNumber(
  value: unknown,
  rule: Extract<LeafRule, { kind: "number" | "integer" }>,
): LeafProblem | null {
  const integer = rule.kind === "integer";
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return {
      code: integer ? "int_type" : "float_type",
      message: integer ? "Input should be a valid integer" : "Input should be a valid number",
    };
  }
  if (integer && !Number.isInteger(value)) {
    return {
      code: "int_from_float",
      message: "Input should be a valid integer, got a number with a fractional part",
    };
  }
  const exclusiveMin = rule.kind === "number" ? rule.exclusiveMin : undefined;
  if (exclusiveMin !== undefined && value <= exclusiveMin) {
    return { code: "greater_than", message: `Input should be greater than ${exclusiveMin}` };
  }
  if (rule.min !== undefined && value < rule.min) {
    return {
      code: "greater_than_equal",
      message: `Input should be greater than or equal to ${rule.min}`,
    };
  }
  if (rule.max !== undefined && value > rule.max) {
    return {
      code: "less_than_equal",
      message: `Input should be less than or equal to ${rule.max}`,
    };
  }
  return null;
}

function checkUrl(value: unknown): LeafProblem | null {
  if (typeof value !== "string") {
    return { code: "string_type", message: "Input should be a valid string" };
  }
  if (value.length > URL_MAX_LENGTH) {
    return {
      code: "string_too_long",
      message: `String should have at most ${URL_MAX_LENGTH} characters`,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return {
      code: "url_parsing",
      message: "Input should be a valid URL, relative URL without a base",
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { code: "url_scheme", message: "URL scheme should be 'http' or 'https'" };
  }
  if (parsed.host === "") {
    return { code: "url_parsing", message: "Input should be a valid URL, empty host" };
  }
  return null;
}

function checkBoolean(value: unknown): LeafProblem | null {
  return typeof value === "boolean"
    ? null
    : { code: "bool_type", message: "Input should be a valid boolean" };
}

function checkEmails(value: unknown): LeafProblem | null {
  if (!Array.isArray(value)) {
    return { code: "list_type", message: "Input should be a valid list" };
  }
  if (value.length > EMAIL_MAX_ITEMS) {
    return {
      code: "too_long",
      message: `List should have at most ${EMAIL_MAX_ITEMS} items after validation, not ${value.length}`,
    };
  }
  for (const [index, address] of value.entries()) {
    if (typeof address !== "string") {
      return { code: "string_type", message: "Input should be a valid string", index };
    }
    if (address.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(address)) {
      return { code: "value_error", message: "Enter a valid email address", index };
    }
  }
  return null;
}

function checkLeaf(rule: LeafRule, value: unknown): LeafProblem | null {
  switch (rule.kind) {
    case "boolean":
      return checkBoolean(value);
    case "emails":
      return checkEmails(value);
    case "model":
      return checkModel(value);
    case "effort":
      return EFFORTS.some((effort) => effort === value)
        ? null
        : { code: "enum", message: `Input should be ${joinOptions(EFFORTS)}` };
    case "number":
    case "integer":
      return checkNumber(value, rule);
    case "url":
      return checkUrl(value);
  }
}

function parseLeaf(
  path: readonly string[],
  rule: LeafRule,
  value: unknown,
  result: ParsedSettingsPatch,
): void {
  if (value === null) {
    result.leaves.push({ path, value: null });
    return;
  }
  const problem = checkLeaf(rule, value);
  if (problem !== null) {
    const { index, ...problemDetail } = problem;
    result.details.push({
      loc: ["body", ...path, ...(index === undefined ? [] : [index])],
      ...problemDetail,
    });
    return;
  }
  result.leaves.push({ path, value: value as LeafValue });
}

function extraForbidden(path: readonly string[]): ErrorDetail {
  return {
    loc: ["body", ...path],
    code: "extra_forbidden",
    message: "Extra inputs are not permitted",
  };
}

function notADictionary(path: readonly string[]): ErrorDetail {
  return {
    loc: ["body", ...path],
    code: "dict_type",
    message: "Input should be a valid dictionary",
  };
}

function parseModels(source: unknown, result: ParsedSettingsPatch): void {
  if (!isRecord(source)) {
    result.details.push(notADictionary(["models"]));
    return;
  }
  for (const [role, roleSource] of Object.entries(source)) {
    if (!MODEL_ROLES.some((known) => known === role)) {
      result.details.push(extraForbidden(["models", role]));
      continue;
    }
    if (!isRecord(roleSource)) {
      result.details.push(notADictionary(["models", role]));
      continue;
    }
    for (const [leaf, value] of Object.entries(roleSource)) {
      const rule = MODEL_LEAVES.find((known) => known === leaf);
      if (rule === undefined) {
        result.details.push(extraForbidden(["models", role, leaf]));
      } else {
        parseLeaf(["models", role, leaf], MODEL_LEAF_RULES[rule], value, result);
      }
    }
  }
}

function parseFlatGroup(
  group: Exclude<SettingsGroupName, "models">,
  source: unknown,
  result: ParsedSettingsPatch,
): void {
  if (!isRecord(source)) {
    result.details.push(notADictionary([group]));
    return;
  }
  const rules = FLAT_LEAF_RULES[group];
  for (const [leaf, value] of Object.entries(source)) {
    const rule = rules[leaf];
    if (rule === undefined) {
      result.details.push(extraForbidden([group, leaf]));
    } else {
      parseLeaf([group, leaf], rule, value, result);
    }
  }
}

export function parseSettingsPatch(raw: Record<string, unknown>): ParsedSettingsPatch {
  const result: ParsedSettingsPatch = { leaves: [], details: [] };
  for (const [group, source] of Object.entries(raw)) {
    if (!SETTINGS_GROUPS.some((known) => known === group)) {
      result.details.push(extraForbidden([group]));
    } else if (group === "models") {
      parseModels(source, result);
    } else {
      parseFlatGroup(group as Exclude<SettingsGroupName, "models">, source, result);
    }
  }
  return result;
}
