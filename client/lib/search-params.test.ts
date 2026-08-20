import { describe, expect, it } from "vitest";
import {
  booleanParam,
  createSearchParamsCodec,
  enumListParam,
  enumParam,
  sortParam,
  stringListParam,
  textParam,
  toRawSearchParams,
} from "./search-params";

const APP_KINDS = ["web", "api", "llm_assistant"] as const;

const codec = createSearchParamsCodec(
  {
    q: textParam(10),
    app_kind: enumListParam(APP_KINDS),
    area: stringListParam({ maxItems: 3 }),
    include_archived: booleanParam(),
    tier: enumParam(["qa", "production"]),
  },
  { defaults: { include_archived: false } },
);

function parse(query: string) {
  return codec.parse(new URLSearchParams(query));
}

describe("createSearchParamsCodec parse", () => {
  it("returns undefined for every absent key", () => {
    expect(parse("")).toEqual({
      q: undefined,
      app_kind: undefined,
      area: undefined,
      include_archived: undefined,
      tier: undefined,
    });
  });

  it("reads text, repeated enum values, string lists, booleans and a single enum", () => {
    expect(
      parse(
        "q=grac&app_kind=api&app_kind=web&area=Reports&area=Smart+Log&include_archived=true&tier=qa",
      ),
    ).toEqual({
      q: "grac",
      app_kind: ["web", "api"],
      area: ["Reports", "Smart Log"],
      include_archived: true,
      tier: "qa",
    });
  });

  it("never throws on hand-edited values and falls back to undefined", () => {
    expect(parse("q=%20%20&app_kind=mainframe&include_archived=maybe&tier=staging&area=")).toEqual({
      q: undefined,
      app_kind: undefined,
      area: undefined,
      include_archived: undefined,
      tier: undefined,
    });
  });

  it("keeps only the allowed enum values, once each, in the declared order", () => {
    expect(
      parse("app_kind=llm_assistant&app_kind=nope&app_kind=llm_assistant&app_kind=web").app_kind,
    ).toEqual(["web", "llm_assistant"]);
  });

  it("trims and truncates text and limits list items", () => {
    expect(parse("q=%20abcdefghijklmnop%20").q).toBe("abcdefghij");
    expect(parse("area=a&area=b&area=a&area=c&area=d").area).toEqual(["a", "b", "c"]);
  });

  it("reads the first value of a repeated single-value key and 1 or 0 as booleans", () => {
    expect(parse("q=first&q=second").q).toBe("first");
    expect(parse("include_archived=1").include_archived).toBe(true);
    expect(parse("include_archived=0").include_archived).toBe(false);
  });

  it("ignores keys it does not own", () => {
    expect(Object.keys(parse("tab=plans&selection=a&q=x"))).not.toContain("tab");
    expect(toRawSearchParams(new URLSearchParams("a=1&a=2&b=3"), ["a"])).toEqual({ a: ["1", "2"] });
  });
});

describe("sortParam", () => {
  const sortCodec = createSearchParamsCodec(
    { sort: sortParam(["name", "created_at"]) },
    { defaults: { sort: "-created_at" } },
  );

  it("normalises, drops unknown keys and omits the default from the URL", () => {
    expect(sortCodec.parse(new URLSearchParams("sort=name,-slug,-name")).sort).toBe("name");
    expect(sortCodec.parse(new URLSearchParams("sort=slug")).sort).toBeUndefined();
    expect(sortCodec.parse(new URLSearchParams("")).sort).toBeUndefined();
    expect(sortCodec.serialize({ sort: "-created_at" }).toString()).toBe("");
    expect(sortCodec.serialize({ sort: "name" }).toString()).toBe("sort=name");
    expect(sortCodec.serialize({ sort: "-created_at,name" }).toString()).toBe(
      "sort=-created_at%2Cname",
    );
  });
});

describe("createSearchParamsCodec serialize", () => {
  it("writes arrays as repeated keys in the declared key order", () => {
    const params = codec.serialize({
      tier: "production",
      app_kind: ["api", "web"],
      q: "gracie",
    });
    expect(params.toString()).toBe("q=gracie&app_kind=api&app_kind=web&tier=production");
  });

  it("omits empty values and values equal to their default", () => {
    expect(
      codec.serialize({ q: "", app_kind: [], area: undefined, include_archived: false }).toString(),
    ).toBe("");
    expect(codec.serialize({ include_archived: true }).toString()).toBe("include_archived=true");
  });

  it("round trips through the URL", () => {
    const values = {
      q: "bill",
      app_kind: ["web" as const, "api" as const],
      area: ["Smart Log", "Reports"],
      include_archived: true,
      tier: "qa" as const,
    };
    const parsed = codec.parse(new URLSearchParams(codec.serialize(values).toString()));
    expect(parsed).toEqual({ ...values, app_kind: ["web", "api"] });
  });

  it("escapes special characters", () => {
    const text = codec.serialize({ area: ["R&D", "a=b"] }).toString();
    expect(text).toBe("area=R%26D&area=a%3Db");
    expect(parse(text).area).toEqual(["R&D", "a=b"]);
  });
});

describe("createSearchParamsCodec activeKeys", () => {
  it("lists keys that carry a non-default, non-empty value", () => {
    expect(codec.activeKeys({ q: "x", app_kind: [], include_archived: false })).toEqual(["q"]);
    expect(codec.activeKeys({ include_archived: true, tier: "qa" })).toEqual([
      "include_archived",
      "tier",
    ]);
    expect(codec.activeKeys({})).toEqual([]);
  });
});
