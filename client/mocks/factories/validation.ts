import type { ErrorDetail } from "../types";
import { isUuid } from "./ids";
import { validationFailed } from "./errors";

export type LocationPrefix = "body" | "query" | "header" | "path";

interface StringRules {
  min?: number;
  max?: number;
}

interface IntegerRules {
  min?: number;
  max?: number;
  fallback?: number;
}

export class FieldValidator {
  readonly details: ErrorDetail[];
  private readonly prefix: LocationPrefix;

  constructor(prefix: LocationPrefix, details: ErrorDetail[] = []) {
    this.prefix = prefix;
    this.details = details;
  }

  forLocation(prefix: LocationPrefix): FieldValidator {
    return new FieldValidator(prefix, this.details);
  }

  private add(field: string, code: string, message: string): void {
    this.details.push({ loc: [this.prefix, field], code, message });
  }

  private checkBounds(field: string, value: number, rules: { min?: number; max?: number }) {
    if (rules.min !== undefined && value < rules.min) {
      this.add(
        field,
        "greater_than_equal",
        `Input should be greater than or equal to ${rules.min}`,
      );
      return false;
    }
    if (rules.max !== undefined && value > rules.max) {
      this.add(field, "less_than_equal", `Input should be less than or equal to ${rules.max}`);
      return false;
    }
    return true;
  }

  requiredString(source: Record<string, unknown>, field: string, rules: StringRules = {}) {
    const value = source[field];
    if (value === undefined) {
      this.add(field, "missing", "Field required");
      return undefined;
    }
    if (typeof value !== "string") {
      this.add(field, "string_type", "Input should be a valid string");
      return undefined;
    }
    if (rules.min !== undefined && value.length < rules.min) {
      this.add(
        field,
        "string_too_short",
        `String should have at least ${rules.min} character${rules.min === 1 ? "" : "s"}`,
      );
      return undefined;
    }
    if (rules.max !== undefined && value.length > rules.max) {
      this.add(
        field,
        "string_too_long",
        `String should have at most ${rules.max} character${rules.max === 1 ? "" : "s"}`,
      );
      return undefined;
    }
    return value;
  }

  requiredUuid(source: Record<string, unknown>, field: string) {
    const value = source[field];
    if (value === undefined) {
      this.add(field, "missing", "Field required");
      return undefined;
    }
    if (typeof value !== "string") {
      this.add(field, "uuid_type", "UUID input should be a string, bytes or UUID object");
      return undefined;
    }
    if (!isUuid(value)) {
      this.add(
        field,
        "uuid_parsing",
        "Input should be a valid UUID, invalid character: expected an optional prefix of `urn:uuid:` followed by [0-9a-fA-F-], found a non-hexadecimal character",
      );
      return undefined;
    }
    return value;
  }

  integer(source: Record<string, unknown>, field: string, rules: IntegerRules = {}) {
    const value = source[field];
    if (value === undefined) {
      return rules.fallback;
    }
    if (typeof value !== "number") {
      this.add(field, "int_type", "Input should be a valid integer");
      return undefined;
    }
    if (!Number.isInteger(value)) {
      this.add(
        field,
        "int_from_float",
        "Input should be a valid integer, got a number with a fractional part",
      );
      return undefined;
    }
    return this.checkBounds(field, value, rules) ? value : undefined;
  }

  queryInteger(raw: string | null, field: string, rules: IntegerRules = {}) {
    if (raw === null) {
      return rules.fallback;
    }
    if (!/^[+-]?\d+$/.test(raw.trim())) {
      this.add(
        field,
        "int_parsing",
        "Input should be a valid integer, unable to parse string as an integer",
      );
      return undefined;
    }
    const value = Number.parseInt(raw, 10);
    return this.checkBounds(field, value, rules) ? value : undefined;
  }

  boolean(source: Record<string, unknown>, field: string, fallback: boolean) {
    const value = source[field];
    if (value === undefined) {
      return fallback;
    }
    if (typeof value !== "boolean") {
      this.add(field, "bool_type", "Input should be a valid boolean");
      return undefined;
    }
    return value;
  }

  literal<T extends string>(raw: string | null, field: string, allowed: readonly T[], fallback: T) {
    if (raw === null) {
      return fallback;
    }
    const match = allowed.find((candidate) => candidate === raw);
    if (match === undefined) {
      const options = allowed.map((candidate) => `'${candidate}'`);
      const listed =
        options.length > 1
          ? `${options.slice(0, -1).join(", ")} or ${options[options.length - 1]}`
          : (options[0] ?? "");
      this.add(field, "literal_error", `Input should be ${listed}`);
      return undefined;
    }
    return match;
  }

  finish<T extends Record<string, unknown>>(
    values: T,
  ): { [K in keyof T]: Exclude<T[K], undefined> } {
    if (this.details.length > 0) {
      throw validationFailed(this.details);
    }
    return values as { [K in keyof T]: Exclude<T[K], undefined> };
  }
}

export function parseJsonObject(text: string): Record<string, unknown> {
  if (text.trim() === "") {
    throw validationFailed([{ loc: ["body"], code: "missing", message: "Field required" }]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw validationFailed([
      { loc: ["body", 0], code: "json_invalid", message: "JSON decode error" },
    ]);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw validationFailed([
      {
        loc: ["body"],
        code: "model_attributes_type",
        message: "Input should be a valid dictionary or object to extract fields from",
      },
    ]);
  }
  return Object.fromEntries(Object.entries(parsed));
}
