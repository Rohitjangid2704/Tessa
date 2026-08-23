import { describe, expect, it } from "vitest";
import { CONFIDENCES, FEATURE_KINDS, catalogFiltersCodec, catalogFiltersSchema } from "./schemas";

function parse(query: string) {
  return catalogFiltersCodec.parse(new URLSearchParams(query));
}

describe("catalogFiltersSchema", () => {
  it("reads every filter from repeated and single parameters", () => {
    const values = parse(
      "q=towels&area=Smart%20Log&area=Reports&kind=write&kind=read&role=guest&interface_id=chat_sse&confidence=high",
    );

    expect(values).toEqual({
      q: "towels",
      area: ["Smart Log", "Reports"],
      kind: ["read", "write"],
      role: ["guest"],
      interface_id: ["chat_sse"],
      confidence: ["high"],
    });
  });

  it("returns no filters for an empty query", () => {
    expect(parse("")).toEqual({
      q: undefined,
      area: undefined,
      kind: undefined,
      role: undefined,
      interface_id: undefined,
      confidence: undefined,
    });
  });

  it("drops values outside the enums instead of throwing", () => {
    const values = parse("kind=teleport&kind=job&confidence=certain");

    expect(values.kind).toEqual(["job"]);
    expect(values.confidence).toBeUndefined();
  });

  it("trims text, drops blanks and duplicates and caps the search length", () => {
    const values = parse(
      `q=%20%20gracie%20&area=%20Reports%20&area=Reports&area=&role=${"r".repeat(500)}`,
    );

    expect(values.q).toBe("gracie");
    expect(values.area).toEqual(["Reports"]);
    expect(values.role?.[0]).toHaveLength(200);
    expect(parse(`q=${"x".repeat(500)}`).q).toHaveLength(200);
    expect(parse("q=%20%20").q).toBeUndefined();
  });

  it("ignores parameters it does not own", () => {
    const values = parse("target_id=abc&bundle_id=def&sort=name&kind=read");

    expect(values).toEqual({ kind: ["read"] });
  });

  it("exposes the zod schema that backs the codec", () => {
    const result = catalogFiltersSchema.safeParse({ kind: ["read"], area: ["Reports"] });

    expect(result.success).toBe(true);
  });

  it("covers every feature kind and confidence the API names", () => {
    expect([...FEATURE_KINDS]).toEqual(["read", "write", "flow", "auth", "admin", "stream", "job"]);
    expect([...CONFIDENCES]).toEqual(["high", "medium", "low"]);
  });
});

describe("catalogFiltersCodec", () => {
  it("serializes only what is set and round-trips", () => {
    const params = catalogFiltersCodec.serialize({
      q: "log",
      area: ["Smart Log"],
      kind: ["read", "write"],
    });

    expect(params.toString()).toBe("q=log&area=Smart+Log&kind=read&kind=write");
    expect(parse(params.toString())).toMatchObject({
      q: "log",
      area: ["Smart Log"],
      kind: ["read", "write"],
    });
  });

  it("reports the active keys for the filter count", () => {
    expect(catalogFiltersCodec.activeKeys(parse(""))).toEqual([]);
    expect(catalogFiltersCodec.activeKeys(parse("q=a&role=guest&role=admin"))).toEqual([
      "q",
      "role",
    ]);
  });
});
