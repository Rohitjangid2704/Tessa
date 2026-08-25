import type { ErrorDetail } from "../types";

export type Source = Record<string, unknown>;

export type Loc = Array<string | number>;

function joinOptions(options: readonly string[]): string {
  const quoted = options.map((option) => `'${option}'`);
  const last = quoted[quoted.length - 1] ?? "";
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} or ${last}` : last;
}

export class BodyReader {
  readonly details: ErrorDetail[] = [];
  private readonly source: Source;
  private readonly base: Loc;

  constructor(source: Source, base: Loc = ["body"]) {
    this.source = source;
    this.base = base;
  }

  issue(field: string | number, code: string, message: string): void {
    this.details.push({ loc: [...this.base, field], code, message });
  }

  private missing(field: string): undefined {
    this.issue(field, "missing", "Field required");
    return undefined;
  }

  has(field: string): boolean {
    return field in this.source;
  }

  string(
    field: string,
    rules: { required: boolean; min?: number; max?: number; strip?: boolean; nullable?: boolean },
  ): string | null | undefined {
    const raw = this.source[field];
    if (raw === undefined) {
      return rules.required ? this.missing(field) : undefined;
    }
    if (raw === null && rules.nullable) {
      return null;
    }
    if (typeof raw !== "string") {
      this.issue(field, "string_type", "Input should be a valid string");
      return undefined;
    }
    const value = rules.strip ? raw.trim() : raw;
    if (rules.min !== undefined && value.length < rules.min) {
      this.issue(
        field,
        "string_too_short",
        `String should have at least ${rules.min} character${rules.min === 1 ? "" : "s"}`,
      );
      return undefined;
    }
    if (rules.max !== undefined && value.length > rules.max) {
      this.issue(
        field,
        "string_too_long",
        `String should have at most ${rules.max} character${rules.max === 1 ? "" : "s"}`,
      );
      return undefined;
    }
    return value;
  }

  enum<Value extends string>(
    field: string,
    allowed: readonly Value[],
    rules: { required: boolean; nullable?: boolean },
  ): Value | null | undefined {
    const raw = this.source[field];
    if (raw === undefined) {
      return rules.required ? this.missing(field) : undefined;
    }
    if (raw === null && rules.nullable) {
      return null;
    }
    const match = allowed.find((candidate) => candidate === raw);
    if (match === undefined) {
      this.issue(field, "enum", `Input should be ${joinOptions(allowed)}`);
      return undefined;
    }
    return match;
  }

  uuid(field: string, rules: { required: boolean; nullable?: boolean }): string | null | undefined {
    const raw = this.source[field];
    if (raw === undefined) {
      return rules.required ? this.missing(field) : undefined;
    }
    if (raw === null && rules.nullable) {
      return null;
    }
    if (typeof raw !== "string") {
      this.issue(field, "uuid_type", "UUID input should be a string, bytes or UUID object");
      return undefined;
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
      this.issue(
        field,
        "uuid_parsing",
        "Input should be a valid UUID, invalid character: expected an optional prefix of `urn:uuid:` followed by [0-9a-fA-F-], found a non-hexadecimal character",
      );
      return undefined;
    }
    return raw.toLowerCase();
  }

  boolean(field: string, rules: { nullable?: boolean }): boolean | null | undefined {
    const raw = this.source[field];
    if (raw === undefined) {
      return undefined;
    }
    if (raw === null && rules.nullable) {
      return null;
    }
    if (typeof raw !== "boolean") {
      this.issue(field, "bool_type", "Input should be a valid boolean");
      return undefined;
    }
    return raw;
  }

  object(field: string, rules: { nullable?: boolean }): Source | null | undefined {
    const raw = this.source[field];
    if (raw === undefined) {
      return undefined;
    }
    if (raw === null && rules.nullable) {
      return null;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      this.issue(field, "dict_type", "Input should be a valid dictionary");
      return undefined;
    }
    return Object.fromEntries(Object.entries(raw));
  }

  stringList(
    field: string,
    rules: { nullable?: boolean; maxItems?: number },
  ): string[] | null | undefined {
    const raw = this.source[field];
    if (raw === undefined) {
      return undefined;
    }
    if (raw === null && rules.nullable) {
      return null;
    }
    if (!Array.isArray(raw)) {
      this.issue(field, "list_type", "Input should be a valid list");
      return undefined;
    }
    if (rules.maxItems !== undefined && raw.length > rules.maxItems) {
      this.issue(
        field,
        "too_long",
        `List should have at most ${rules.maxItems} items after validation, not ${raw.length}`,
      );
      return undefined;
    }
    const accepted: string[] = [];
    raw.forEach((item: unknown, index) => {
      if (typeof item === "string") {
        accepted.push(item);
      } else {
        this.details.push({
          loc: [...this.base, field, index],
          code: "string_type",
          message: "Input should be a valid string",
        });
      }
    });
    return accepted;
  }
}
