import {
  analyzeSchema,
  isJsonObject,
  type FieldSpec,
  type JsonObject,
  type SchemaPlan,
} from "./subset";
import { FORM_ERROR_KEY, validateAgainstSchema, type FieldErrors } from "./validate";

export interface SchemaDraft {
  values: Readonly<Record<string, string>>;
  raw: string;
}

export interface ResolvedDraft {
  value: JsonObject | null;
  errors: FieldErrors;
}

const BOOLEAN_TRUE = "true";
const BOOLEAN_FALSE = "false";
const WHOLE_NUMBER = /^[+-]?\d+$/;

function textOfDefault(spec: FieldSpec): string {
  if (spec.kind === "boolean") {
    return spec.defaultValue === true ? BOOLEAN_TRUE : BOOLEAN_FALSE;
  }
  if (spec.kind === "list") {
    return JSON.stringify(Array.isArray(spec.defaultValue) ? spec.defaultValue : []);
  }
  if (spec.kind === "object") {
    return spec.defaultValue === undefined ? "" : JSON.stringify(spec.defaultValue, null, 2);
  }
  return spec.defaultValue === undefined ? "" : String(spec.defaultValue);
}

function textOfValue(spec: FieldSpec, value: unknown): string {
  if (spec.kind === "boolean") {
    return value === true ? BOOLEAN_TRUE : BOOLEAN_FALSE;
  }
  if (spec.kind === "list" && Array.isArray(value)) {
    return JSON.stringify(value);
  }
  if (spec.kind === "object" && isJsonObject(value)) {
    return JSON.stringify(value, null, 2);
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return textOfDefault(spec);
}

export function listOfDraftText(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function draftTextOfList(items: readonly string[]): string {
  return JSON.stringify(items);
}

function parseJson(text: string): { parsed?: unknown; error?: string } {
  try {
    return { parsed: JSON.parse(text) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "unreadable text" };
  }
}

export function defaultValueOf(plan: SchemaPlan): JsonObject {
  if (plan.mode !== "fields") {
    return {};
  }
  const value: JsonObject = {};
  for (const spec of plan.fields) {
    if (spec.defaultValue !== undefined) {
      value[spec.name] = spec.defaultValue;
    }
  }
  return value;
}

export function createDraft(schema: unknown, initial?: JsonObject): SchemaDraft {
  const plan = analyzeSchema(schema);
  const values: Record<string, string> = {};
  if (plan.mode === "fields") {
    for (const spec of plan.fields) {
      values[spec.name] =
        initial !== undefined && spec.name in initial
          ? textOfValue(spec, initial[spec.name])
          : textOfDefault(spec);
    }
  }
  const rawSource = initial ?? defaultValueOf(plan);
  return { values, raw: JSON.stringify(rawSource, null, 2) };
}

export function draftWithValue(draft: SchemaDraft, name: string, text: string): SchemaDraft {
  return { ...draft, values: { ...draft.values, [name]: text } };
}

export function draftWithRaw(draft: SchemaDraft, raw: string): SchemaDraft {
  return { ...draft, raw };
}

export function changedKeys(previous: SchemaDraft, next: SchemaDraft): string[] {
  const names = new Set([...Object.keys(previous.values), ...Object.keys(next.values)]);
  const changed = [...names].filter((name) => previous.values[name] !== next.values[name]);
  return previous.raw === next.raw ? changed : [...changed, FORM_ERROR_KEY];
}

function parseField(spec: FieldSpec, text: string): { value?: unknown; error?: string } {
  if (spec.kind === "boolean") {
    return { value: text === BOOLEAN_TRUE };
  }
  const trimmed = spec.kind === "string" ? text : text.trim();
  if (trimmed === "") {
    return {};
  }
  switch (spec.kind) {
    case "integer":
      return WHOLE_NUMBER.test(trimmed)
        ? { value: Number.parseInt(trimmed, 10) }
        : { error: "Enter a whole number" };
    case "number": {
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? { value: parsed } : { error: "Enter a number" };
    }
    case "enum": {
      const option = spec.options.find((candidate) => candidate.value === trimmed);
      return option === undefined
        ? { error: "Choose one of the listed values" }
        : { value: option.json };
    }
    case "list": {
      const { parsed, error } = parseJson(trimmed);
      if (error !== undefined) {
        return { error: `Not a valid list: ${error}` };
      }
      return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
        ? { value: parsed }
        : { error: "Enter a list of text items" };
    }
    case "object": {
      const { parsed, error } = parseJson(trimmed);
      if (error !== undefined) {
        return { error: `Not valid JSON: ${error}` };
      }
      return isJsonObject(parsed) ? { value: parsed } : { error: "Enter a JSON object" };
    }
    default:
      return { value: trimmed };
  }
}

function resolveFields(
  schema: unknown,
  fields: readonly FieldSpec[],
  draft: SchemaDraft,
): ResolvedDraft {
  const value: JsonObject = {};
  const errors: FieldErrors = {};
  for (const spec of fields) {
    const parsed = parseField(spec, draft.values[spec.name] ?? "");
    if (parsed.error !== undefined) {
      errors[spec.name] = parsed.error;
    } else if (parsed.value !== undefined) {
      value[spec.name] = parsed.value;
    }
  }
  const schemaErrors = validateAgainstSchema(schema, value);
  for (const [name, message] of Object.entries(schemaErrors)) {
    errors[name] ??= message;
  }
  return { value: Object.keys(errors).length === 0 ? value : null, errors };
}

function resolveRaw(schema: unknown, draft: SchemaDraft): ResolvedDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(draft.raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unreadable text";
    return { value: null, errors: { [FORM_ERROR_KEY]: `Not valid JSON: ${detail}` } };
  }
  if (!isJsonObject(parsed)) {
    return { value: null, errors: { [FORM_ERROR_KEY]: "Parameters must be a JSON object" } };
  }
  const errors = validateAgainstSchema(schema, parsed);
  return { value: Object.keys(errors).length === 0 ? parsed : null, errors };
}

export function resolveDraft(schema: unknown, draft: SchemaDraft): ResolvedDraft {
  const plan = analyzeSchema(schema);
  switch (plan.mode) {
    case "empty":
      return { value: {}, errors: {} };
    case "raw":
      return resolveRaw(schema, draft);
    case "fields":
      return resolveFields(schema, plan.fields, draft);
  }
}
