import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import { isJsonObject, type JsonObject } from "./subset";

export type FieldErrors = Record<string, string>;

export const FORM_ERROR_KEY = "";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(text: string): boolean {
  const match = DATE_PATTERN.exec(text);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const moment = new Date(Date.UTC(year, month - 1, day));
  return (
    moment.getUTCFullYear() === year &&
    moment.getUTCMonth() === month - 1 &&
    moment.getUTCDate() === day
  );
}

function createValidator(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: false, logger: false });
  ajv.addFormat("date", { type: "string", validate: isIsoDate });
  return ajv;
}

const ajv = createValidator();
const compiled = new WeakMap<object, ValidateFunction | null>();

function compile(schema: JsonObject): ValidateFunction | null {
  if (compiled.has(schema)) {
    return compiled.get(schema) ?? null;
  }
  let validate: ValidateFunction | null;
  try {
    validate = ajv.compile(schema);
  } catch {
    validate = null;
  }
  compiled.set(schema, validate);
  return validate;
}

function unescapePointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function pathOf(error: ErrorObject): string {
  const segments = error.instancePath.split("/").slice(1).map(unescapePointerSegment);
  if (error.keyword === "required" && typeof error.params.missingProperty === "string") {
    segments.push(error.params.missingProperty);
  }
  if (
    error.keyword === "additionalProperties" &&
    typeof error.params.additionalProperty === "string"
  ) {
    segments.push(error.params.additionalProperty);
  }
  return segments.length === 0 ? FORM_ERROR_KEY : segments.join(".");
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function typeLabel(type: unknown): string {
  const labels: Record<string, string> = {
    integer: "a whole number",
    number: "a number",
    string: "text",
    boolean: "true or false",
    object: "an object",
    array: "a list",
  };
  const names = (Array.isArray(type) ? type : [type]).map(
    (name) => labels[String(name)] ?? "valid",
  );
  return names.join(" or ");
}

export function describeAjvError(error: ErrorObject): string {
  switch (error.keyword) {
    case "required":
      return "Required";
    case "type":
      return `Must be ${typeLabel(error.params.type)}`;
    case "enum":
      return "Choose one of the listed values";
    case "format":
      return error.params.format === "date"
        ? "Use a date such as 2026-10-01"
        : `Does not match the format ${String(error.params.format)}`;
    case "minLength":
      return `Use at least ${String(error.params.limit)} characters`;
    case "maxLength":
      return `Use at most ${String(error.params.limit)} characters`;
    case "pattern":
      return "Does not match the expected pattern";
    case "minimum":
      return `Must be at least ${String(error.params.limit)}`;
    case "maximum":
      return `Must be at most ${String(error.params.limit)}`;
    case "additionalProperties":
      return "Not a known parameter";
    case "minItems":
      return `Add at least ${String(error.params.limit)} items`;
    default:
      return capitalize(error.message ?? "Is not valid");
  }
}

export function validateAgainstSchema(schema: unknown, value: unknown): FieldErrors {
  if (!isJsonObject(schema)) {
    return {};
  }
  const validate = compile(schema);
  if (validate === null || validate(value)) {
    return {};
  }
  const errors: FieldErrors = {};
  for (const error of validate.errors ?? []) {
    errors[pathOf(error)] ??= describeAjvError(error);
  }
  return errors;
}

export function canValidateWithAjv(schema: unknown): boolean {
  return isJsonObject(schema) && compile(schema) !== null;
}
