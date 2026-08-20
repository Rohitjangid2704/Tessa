import { describe, expect, it } from "vitest";
import { canValidateWithAjv, isIsoDate, validateAgainstSchema } from "./validate";

const SCHEMA = {
  type: "object",
  required: ["tenant", "day"],
  additionalProperties: false,
  properties: {
    tenant: { type: "string", minLength: 3, maxLength: 8, pattern: "^[a-z-]+$" },
    day: { type: "string", format: "date" },
    limit: { type: "integer", minimum: 1, maximum: 10 },
    role: { type: "string", enum: ["a", "b"] },
    ratio: { type: "number", minimum: 0.5 },
  },
};

describe("validateAgainstSchema", () => {
  it("accepts a valid value", () => {
    expect(validateAgainstSchema(SCHEMA, { tenant: "demo", day: "2026-10-01", limit: 3 })).toEqual(
      {},
    );
  });

  it("reports required properties by name", () => {
    expect(validateAgainstSchema(SCHEMA, {})).toEqual({ tenant: "Required", day: "Required" });
  });

  it("reports bounds, enum, pattern and number errors in plain words", () => {
    const errors = validateAgainstSchema(SCHEMA, {
      tenant: "AB",
      day: "2026-10-01",
      limit: 0,
      role: "c",
      ratio: 0.1,
    });

    expect(errors).toEqual({
      tenant: "Use at least 3 characters",
      limit: "Must be at least 1",
      role: "Choose one of the listed values",
      ratio: "Must be at least 0.5",
    });
    expect(validateAgainstSchema(SCHEMA, { tenant: "abcdefghi", day: "2026-10-01" }).tenant).toBe(
      "Use at most 8 characters",
    );
    expect(validateAgainstSchema(SCHEMA, { tenant: "Bad_1", day: "2026-10-01" }).tenant).toBe(
      "Does not match the expected pattern",
    );
    expect(
      validateAgainstSchema(SCHEMA, { tenant: "demo", day: "2026-10-01", limit: 11 }).limit,
    ).toBe("Must be at most 10");
  });

  it("reports wrong types and unknown properties", () => {
    const errors = validateAgainstSchema(SCHEMA, {
      tenant: 5,
      day: "2026-10-01",
      limit: 1.5,
      extra: true,
    });

    expect(errors).toEqual({
      tenant: "Must be text",
      limit: "Must be a whole number",
      extra: "Not a known parameter",
    });
  });

  it("validates the date format with a real calendar check", () => {
    expect(validateAgainstSchema(SCHEMA, { tenant: "demo", day: "2026-02-30" }).day).toBe(
      "Use a date such as 2026-10-01",
    );
    expect(validateAgainstSchema(SCHEMA, { tenant: "demo", day: "10/01/2026" }).day).toBe(
      "Use a date such as 2026-10-01",
    );
    expect(validateAgainstSchema(SCHEMA, { tenant: "demo", day: "2028-02-29" })).toEqual({});
  });

  it("keys root errors with the empty string and nested errors with dots", () => {
    expect(validateAgainstSchema({ type: "object" }, [])).toEqual({ "": "Must be an object" });
    expect(
      validateAgainstSchema(
        {
          type: "object",
          properties: { a: { type: "object", properties: { b: { type: "integer" } } } },
        },
        { a: { b: "x" } },
      ),
    ).toEqual({ "a.b": "Must be a whole number" });
  });

  it("describes unsupported keywords through the Ajv message", () => {
    const errors = validateAgainstSchema(
      { type: "object", properties: { a: { type: "string", const: "x" } } },
      { a: "y" },
    );

    expect(errors.a).toBe("Must be equal to constant");
  });

  it("ignores unknown formats and returns no errors for a schema Ajv cannot compile", () => {
    expect(
      validateAgainstSchema(
        { type: "object", properties: { a: { type: "string", format: "made-up" } } },
        { a: "x" },
      ),
    ).toEqual({});
    expect(validateAgainstSchema({ type: "not-a-type" }, {})).toEqual({});
    expect(canValidateWithAjv({ type: "not-a-type" })).toBe(false);
    expect(canValidateWithAjv(SCHEMA)).toBe(true);
    expect(validateAgainstSchema("text", {})).toEqual({});
  });
});

describe("isIsoDate", () => {
  it("accepts real dates only", () => {
    expect(isIsoDate("2026-10-05")).toBe(true);
    expect(isIsoDate("2026-00-05")).toBe(false);
    expect(isIsoDate("2026-10-32")).toBe(false);
    expect(isIsoDate("2026-1-5")).toBe(false);
    expect(isIsoDate("")).toBe(false);
  });
});
