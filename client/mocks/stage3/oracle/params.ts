import type { ErrorDetail } from "../../types";
import type { OracleRow } from "./rows";

type JsonObject = Record<string, unknown>;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const PARAMS_LOCATION = ["body", "params"] as const;
const NOT_AVAILABLE = "n/a";

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidDate(text: string): boolean {
  const match = DATE_PATTERN.exec(text);
  if (match === null) {
    return false;
  }
  const [, year, month, day] = match;
  const moment = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    moment.getUTCFullYear() === Number(year) &&
    moment.getUTCMonth() === Number(month) - 1 &&
    moment.getUTCDate() === Number(day)
  );
}

function joinOptions(options: readonly unknown[]): string {
  const quoted = options.map((option) =>
    typeof option === "string" ? `'${option}'` : String(option),
  );
  const last = quoted[quoted.length - 1] ?? "";
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} or ${last}` : last;
}

function issue(name: string, code: string, message: string): ErrorDetail {
  return { loc: [...PARAMS_LOCATION, name], code, message };
}

function checkNumberBounds(name: string, value: number, property: JsonObject): ErrorDetail[] {
  const minimum = property.minimum;
  const maximum = property.maximum;
  if (typeof minimum === "number" && value < minimum) {
    return [
      issue(name, "greater_than_equal", `Input should be greater than or equal to ${minimum}`),
    ];
  }
  if (typeof maximum === "number" && value > maximum) {
    return [issue(name, "less_than_equal", `Input should be less than or equal to ${maximum}`)];
  }
  return [];
}

function checkString(name: string, value: unknown, property: JsonObject): ErrorDetail[] {
  if (typeof value !== "string") {
    return [issue(name, "string_type", "Input should be a valid string")];
  }
  const minLength = property.minLength;
  if (typeof minLength === "number" && value.length < minLength) {
    return [
      issue(
        name,
        "string_too_short",
        `String should have at least ${minLength} character${minLength === 1 ? "" : "s"}`,
      ),
    ];
  }
  const maxLength = property.maxLength;
  if (typeof maxLength === "number" && value.length > maxLength) {
    return [
      issue(
        name,
        "string_too_long",
        `String should have at most ${maxLength} character${maxLength === 1 ? "" : "s"}`,
      ),
    ];
  }
  if (property.format === "date" && !isValidDate(value)) {
    return [
      issue(
        name,
        "date_from_datetime_parsing",
        "Input should be a valid date or datetime, invalid character in year",
      ),
    ];
  }
  return [];
}

function checkProperty(name: string, value: unknown, property: JsonObject): ErrorDetail[] {
  const options = property.enum;
  if (Array.isArray(options)) {
    return options.includes(value)
      ? []
      : [issue(name, "enum", `Input should be ${joinOptions(options)}`)];
  }
  switch (property.type) {
    case "string":
      return checkString(name, value, property);
    case "integer":
      if (typeof value !== "number") {
        return [issue(name, "int_type", "Input should be a valid integer")];
      }
      if (!Number.isInteger(value)) {
        return [
          issue(
            name,
            "int_from_float",
            "Input should be a valid integer, got a number with a fractional part",
          ),
        ];
      }
      return checkNumberBounds(name, value, property);
    case "number":
      return typeof value === "number"
        ? checkNumberBounds(name, value, property)
        : [issue(name, "float_type", "Input should be a valid number")];
    case "boolean":
      return typeof value === "boolean"
        ? []
        : [issue(name, "bool_type", "Input should be a valid boolean")];
    default:
      return [];
  }
}

export function validateOracleParams(schema: JsonObject, params: JsonObject): ErrorDetail[] {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const details: ErrorDetail[] = [];
  for (const name of required) {
    if (typeof name === "string" && params[name] === undefined) {
      details.push(issue(name, "missing", "Field required"));
    }
  }
  for (const [name, value] of Object.entries(params)) {
    const property = properties[name];
    if (!isRecord(property)) {
      if (schema.additionalProperties === false) {
        details.push(issue(name, "extra_forbidden", "Extra inputs are not permitted"));
      }
      continue;
    }
    details.push(...checkProperty(name, value, property));
  }
  return details;
}

function textOf(value: unknown): string {
  if (value === undefined || value === null) {
    return NOT_AVAILABLE;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function renderSentence(
  template: string,
  params: JsonObject,
  rows: readonly OracleRow[],
): string {
  return template.replace(/\{([^{}]+)\}/g, (_match, key: string) => {
    if (key === "row_count") {
      return String(rows.length);
    }
    if (key.startsWith("first.")) {
      return textOf(rows[0]?.[key.slice("first.".length)]);
    }
    return textOf(params[key]);
  });
}
