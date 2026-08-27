export type SchemaIssue = {
  path: Array<string | number>;
  pointer: string;
  message: string;
};

type Schema = Record<string, unknown>;

const DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function pointerOf(path: Array<string | number>): string {
  return path.map((part) => `/${String(part).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

function typeName(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return typeof value;
}

function typeMatches(expected: string, value: unknown): boolean {
  const actual = typeName(value);
  return actual === expected || (expected === "number" && actual === "integer");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) {
    return String(value);
  }
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

export class SchemaValidator {
  private readonly issues: SchemaIssue[] = [];

  constructor(
    private readonly root: Schema,
    private readonly limit: number,
  ) {}

  run(value: unknown): SchemaIssue[] {
    this.check(this.root, value, [], this.issues);
    return this.issues;
  }

  private resolve(reference: string): Schema | undefined {
    if (!reference.startsWith("#/")) {
      return undefined;
    }
    let current: unknown = this.root;
    for (const part of reference.slice(2).split("/")) {
      if (!isRecord(current)) {
        return undefined;
      }
      current = current[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    }
    return isRecord(current) ? current : undefined;
  }

  private add(sink: SchemaIssue[], path: Array<string | number>, message: string): void {
    if (sink === this.issues && sink.length >= this.limit) {
      return;
    }
    sink.push({ path: [...path], pointer: pointerOf(path), message });
  }

  private check(schema: Schema, value: unknown, path: Array<string | number>, sink: SchemaIssue[]): void {
    if (typeof schema.$ref === "string") {
      const target = this.resolve(schema.$ref);
      if (target !== undefined) {
        this.check(target, value, path, sink);
      }
    }
    if (Array.isArray(schema.anyOf)) {
      this.checkAnyOf(schema.anyOf as Schema[], value, path, sink);
    }
    if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
      this.add(sink, path, `must be ${describe(schema.const)}`);
      return;
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) {
      this.add(
        sink,
        path,
        `must be one of ${schema.enum.map((entry) => describe(entry)).join(", ")}, got ${describe(value)}`,
      );
      return;
    }
    if (typeof schema.type === "string" && !typeMatches(schema.type, value)) {
      this.add(sink, path, `must be ${schema.type}, got ${typeName(value)}`);
      return;
    }
    if (typeof value === "string") {
      this.checkString(schema, value, path, sink);
    } else if (typeof value === "number") {
      this.checkNumber(schema, value, path, sink);
    } else if (Array.isArray(value)) {
      this.checkArray(schema, value, path, sink);
    } else if (isRecord(value)) {
      this.checkObject(schema, value, path, sink);
    }
  }

  private checkAnyOf(branches: Schema[], value: unknown, path: Array<string | number>, sink: SchemaIssue[]): void {
    let best: SchemaIssue[] | null = null;
    for (const branch of branches) {
      const attempt: SchemaIssue[] = [];
      this.check(branch, value, path, attempt);
      if (attempt.length === 0) {
        return;
      }
      if (branch.type !== "null" && (best === null || attempt.length < best.length)) {
        best = attempt;
      }
    }
    if (best === null) {
      this.add(sink, path, "does not match any allowed form");
      return;
    }
    for (const issue of best) {
      this.add(sink, issue.path, issue.message);
    }
  }

  private checkString(schema: Schema, value: string, path: Array<string | number>, sink: SchemaIssue[]): void {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      this.add(sink, path, `must have at least ${schema.minLength} characters`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      this.add(sink, path, `must have at most ${schema.maxLength} characters, has ${value.length}`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
      this.add(sink, path, `must match ${schema.pattern}`);
    }
    if (schema.format === "date-time" && !DATE_TIME.test(value)) {
      this.add(sink, path, "must be a date-time with a UTC offset, for example 2026-10-08T09:30:00Z");
    }
    if (schema.format === "uuid" && !UUID.test(value)) {
      this.add(sink, path, "must be a uuid");
    }
  }

  private checkNumber(schema: Schema, value: number, path: Array<string | number>, sink: SchemaIssue[]): void {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      this.add(sink, path, `must be at least ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      this.add(sink, path, `must be at most ${schema.maximum}`);
    }
  }

  private checkArray(schema: Schema, value: unknown[], path: Array<string | number>, sink: SchemaIssue[]): void {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      this.add(sink, path, `must have at least ${schema.minItems} entries`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      this.add(sink, path, `must have at most ${schema.maxItems} entries, has ${value.length}`);
    }
    if (isRecord(schema.items)) {
      const itemSchema = schema.items;
      value.forEach((entry, index) => this.check(itemSchema, entry, [...path, index], sink));
    }
  }

  private checkObject(
    schema: Schema,
    value: Record<string, unknown>,
    path: Array<string | number>,
    sink: SchemaIssue[],
  ): void {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const name of schema.required) {
        if (typeof name === "string" && !(name in value)) {
          this.add(sink, path, `is missing the required key ${name}`);
        }
      }
    }
    for (const [name, entry] of Object.entries(value)) {
      const propertySchema = properties[name];
      if (isRecord(propertySchema)) {
        this.check(propertySchema, entry, [...path, name], sink);
      } else if (schema.additionalProperties === false) {
        this.add(sink, [...path, name], `unknown key ${name}`);
      }
    }
  }
}

export function validateAgainstSchema(schema: Schema, value: unknown, limit = 100): SchemaIssue[] {
  return new SchemaValidator(schema, limit).run(value);
}
