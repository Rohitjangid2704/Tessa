import { describe, expect, it } from "vitest";
import { analyzeSchema, type FieldSpec, type SchemaPlan } from "./subset";

function fieldsOf(plan: SchemaPlan): FieldSpec[] {
  if (plan.mode !== "fields") {
    throw new Error(`expected fields, got ${plan.mode}`);
  }
  return plan.fields;
}

function reasonOf(plan: SchemaPlan): string {
  if (plan.mode !== "raw") {
    throw new Error(`expected raw, got ${plan.mode}`);
  }
  return plan.reason;
}

const objectOf = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
});

describe("analyzeSchema supported subset", () => {
  it("describes string, integer, number, boolean, enum and date properties", () => {
    const plan = analyzeSchema(
      objectOf(
        {
          tenant: { type: "string", title: "Tenant", description: "Property id", minLength: 3 },
          limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
          ratio: { type: "number" },
          closed: { type: "boolean", default: true },
          role: { type: "string", enum: ["a", "b"] },
          day: { type: "string", format: "date" },
        },
        ["tenant", "day"],
      ),
    );

    expect(fieldsOf(plan).map((field) => [field.name, field.kind, field.required])).toEqual([
      ["tenant", "string", true],
      ["limit", "integer", false],
      ["ratio", "number", false],
      ["closed", "boolean", false],
      ["role", "enum", false],
      ["day", "date", true],
    ]);
    const [tenant, limit, , closed, role] = fieldsOf(plan);
    expect(tenant).toMatchObject({
      label: "Tenant",
      description: "Property id",
      bounds: { minLength: 3 },
    });
    expect(limit).toMatchObject({ defaultValue: 50, bounds: { minimum: 1, maximum: 200 } });
    expect(closed?.defaultValue).toBe(true);
    expect(role?.options.map((option) => option.value)).toEqual(["a", "b"]);
  });

  it("uses the property name as the label when there is no title", () => {
    const [field] = fieldsOf(analyzeSchema(objectOf({ tenant_id: { type: "string" } })));

    expect(field?.label).toBe("tenant_id");
  });

  it("keeps numeric enums as numbers in the option json and infers the type from an enum", () => {
    const [numeric, inferred] = fieldsOf(
      analyzeSchema(
        objectOf({
          level: { type: "integer", enum: [1, 2, 3] },
          mood: { enum: ["calm", "angry"] },
        }),
      ),
    );

    expect(numeric?.options).toEqual([
      { value: "1", label: "1", json: 1 },
      { value: "2", label: "2", json: 2 },
      { value: "3", label: "3", json: 3 },
    ]);
    expect(inferred).toMatchObject({ kind: "enum" });
  });

  it("accepts annotation keywords at the top level and additionalProperties as a boolean", () => {
    const plan = analyzeSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "Params",
      description: "d",
      additionalProperties: false,
      ...objectOf({ a: { type: "string", examples: ["x"] } }),
    });

    expect(plan.mode).toBe("fields");
  });

  it("treats schemas without properties as empty", () => {
    expect(analyzeSchema({})).toEqual({ mode: "empty" });
    expect(analyzeSchema({ type: "object" })).toEqual({ mode: "empty" });
    expect(analyzeSchema({ type: "object", properties: {} })).toEqual({ mode: "empty" });
  });
});

describe("analyzeSchema fallbacks to raw JSON", () => {
  it.each([
    ["an array property", objectOf({ tags: { type: "array", items: { type: "string" } } })],
    ["a nested object", objectOf({ nested: { type: "object", properties: {} } })],
    ["a oneOf", { oneOf: [{ type: "object" }] }],
    ["a $ref", { ...objectOf({ a: { $ref: "#/$defs/a" } }), $defs: {} }],
    ["an unknown format", objectOf({ when: { type: "string", format: "date-time" } })],
    ["a nullable type", objectOf({ maybe: { type: ["string", "null"] } })],
    ["a mixed enum", objectOf({ mixed: { enum: ["a", 1] } })],
    ["an empty enum", objectOf({ none: { type: "string", enum: [] } })],
    ["a non-object schema", { type: "array" }],
    ["a non-object value", "text"],
    ["a null schema", null],
    [
      "a schema additionalProperties",
      { ...objectOf({ a: { type: "string" } }), additionalProperties: {} },
    ],
    ["a bad pattern", objectOf({ a: { type: "string", pattern: "(" } })],
    ["a mismatched default", objectOf({ a: { type: "integer", default: "x" } })],
    ["a property that is not an object", objectOf({ a: true })],
    ["required names that are not declared", objectOf({ a: { type: "string" } }, ["b"])],
    ["a format on a number", objectOf({ a: { type: "number", format: "date" } })],
  ])("falls back for %s", (_label, schema) => {
    const plan = analyzeSchema(schema);

    expect(plan.mode).toBe("raw");
    expect(reasonOf(plan).length).toBeGreaterThan(0);
  });

  it("names the unsupported keyword in the reason", () => {
    expect(reasonOf(analyzeSchema({ oneOf: [] }))).toContain("`oneOf`");
    expect(reasonOf(analyzeSchema(objectOf({ a: { type: "string", const: "x" } })))).toContain(
      "`const`",
    );
  });
});
