import { describe, expect, it } from "vitest";
import {
  changedKeys,
  createDraft,
  defaultValueOf,
  draftWithRaw,
  draftWithValue,
  resolveDraft,
} from "./draft";
import { analyzeSchema } from "./subset";

const SCHEMA = {
  type: "object",
  required: ["tenant", "day", "role"],
  properties: {
    tenant: { type: "string", minLength: 3, default: "gracie-demo" },
    day: { type: "string", format: "date", default: "2026-10-01" },
    role: { type: "string", enum: ["front_desk", "manager"], default: "front_desk" },
    limit: { type: "integer", minimum: 1, default: 50 },
    ratio: { type: "number" },
    closed: { type: "boolean" },
    level: { type: "integer", enum: [1, 2] },
  },
};

const RAW_SCHEMA = { type: "object", properties: { tags: { type: "array" } }, required: ["tags"] };

describe("createDraft", () => {
  it("starts from the defaults and falls back to empty text and false", () => {
    expect(createDraft(SCHEMA).values).toEqual({
      tenant: "gracie-demo",
      day: "2026-10-01",
      role: "front_desk",
      limit: "50",
      ratio: "",
      closed: "false",
      level: "",
    });
  });

  it("prefers the initial value over the default", () => {
    const draft = createDraft(SCHEMA, { tenant: "other", limit: 7, closed: true, level: 2 });

    expect(draft.values).toMatchObject({
      tenant: "other",
      limit: "7",
      closed: "true",
      level: "2",
      day: "2026-10-01",
    });
    expect(JSON.parse(draft.raw)).toEqual({ tenant: "other", limit: 7, closed: true, level: 2 });
  });

  it("pretty prints the defaults as the raw JSON text", () => {
    expect(JSON.parse(createDraft(SCHEMA).raw)).toEqual({
      tenant: "gracie-demo",
      day: "2026-10-01",
      role: "front_desk",
      limit: 50,
    });
    expect(createDraft({}).raw).toBe("{}");
  });
});

describe("defaultValueOf", () => {
  it("collects only declared defaults and is empty outside the form mode", () => {
    expect(defaultValueOf(analyzeSchema(SCHEMA))).toEqual({
      tenant: "gracie-demo",
      day: "2026-10-01",
      role: "front_desk",
      limit: 50,
    });
    expect(defaultValueOf(analyzeSchema(RAW_SCHEMA))).toEqual({});
  });
});

describe("resolveDraft in form mode", () => {
  it("builds a typed value from the draft", () => {
    const draft = createDraft(SCHEMA, { ratio: 0.25, closed: true, level: 2 });

    expect(resolveDraft(SCHEMA, draft)).toEqual({
      value: {
        tenant: "gracie-demo",
        day: "2026-10-01",
        role: "front_desk",
        limit: 50,
        ratio: 0.25,
        closed: true,
        level: 2,
      },
      errors: {},
    });
  });

  it("omits blank optional fields and reports blank required ones", () => {
    let draft = createDraft(SCHEMA);
    draft = draftWithValue(draft, "limit", "  ");
    draft = draftWithValue(draft, "tenant", "");

    const { value, errors } = resolveDraft(SCHEMA, draft);

    expect(value).toBeNull();
    expect(errors).toEqual({ tenant: "Required" });
  });

  it("reports text that is not a whole number or a number before Ajv runs", () => {
    let draft = createDraft(SCHEMA);
    draft = draftWithValue(draft, "limit", "12.5");
    draft = draftWithValue(draft, "ratio", "abc");

    expect(resolveDraft(SCHEMA, draft).errors).toEqual({
      limit: "Enter a whole number",
      ratio: "Enter a number",
    });
  });

  it("accepts signed and padded numbers", () => {
    let draft = createDraft(SCHEMA);
    draft = draftWithValue(draft, "limit", " +7 ");
    draft = draftWithValue(draft, "ratio", "-1.5e2");

    expect(resolveDraft(SCHEMA, draft).value).toMatchObject({ limit: 7, ratio: -150 });
  });

  it("runs the schema constraints on the typed value", () => {
    let draft = createDraft(SCHEMA);
    draft = draftWithValue(draft, "tenant", "ab");
    draft = draftWithValue(draft, "limit", "0");
    draft = draftWithValue(draft, "day", "2026-02-31");

    expect(resolveDraft(SCHEMA, draft).errors).toEqual({
      tenant: "Use at least 3 characters",
      limit: "Must be at least 1",
      day: "Use a date such as 2026-10-01",
    });
  });

  it("rejects an enum text that is not an option", () => {
    const draft = draftWithValue(createDraft(SCHEMA), "level", "9");

    expect(resolveDraft(SCHEMA, draft).errors).toEqual({
      level: "Choose one of the listed values",
    });
  });

  it("resolves an empty schema to an empty object", () => {
    expect(resolveDraft({}, createDraft({}))).toEqual({ value: {}, errors: {} });
  });
});

describe("resolveDraft in raw mode", () => {
  it("parses the JSON and validates it against the schema when Ajv can", () => {
    const draft = draftWithRaw(createDraft(RAW_SCHEMA), '{"tags": ["a"]}');

    expect(resolveDraft(RAW_SCHEMA, draft)).toEqual({ value: { tags: ["a"] }, errors: {} });
    expect(resolveDraft(RAW_SCHEMA, draftWithRaw(draft, "{}")).errors).toEqual({
      tags: "Required",
    });
  });

  it("reports invalid JSON and non-object JSON on the form level", () => {
    const draft = createDraft(RAW_SCHEMA);

    expect(resolveDraft(RAW_SCHEMA, draftWithRaw(draft, "{")).errors[""]).toMatch(
      /^Not valid JSON/,
    );
    expect(resolveDraft(RAW_SCHEMA, draftWithRaw(draft, "[1]"))).toEqual({
      value: null,
      errors: { "": "Parameters must be a JSON object" },
    });
  });

  it("passes the value through when the schema cannot be compiled", () => {
    const schema = { oneOf: [{ type: "not-a-type" }] };

    expect(resolveDraft(schema, draftWithRaw(createDraft(schema), '{"a": 1}'))).toEqual({
      value: { a: 1 },
      errors: {},
    });
  });
});

describe("changedKeys", () => {
  it("lists changed fields and the form key when the raw text changed", () => {
    const base = createDraft(SCHEMA);

    expect(changedKeys(base, draftWithValue(base, "limit", "9"))).toEqual(["limit"]);
    expect(changedKeys(base, draftWithRaw(base, "{}"))).toEqual([""]);
    expect(changedKeys(base, base)).toEqual([]);
  });
});
