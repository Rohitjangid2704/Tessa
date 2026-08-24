import { describe, expect, it, vi } from "vitest";
import { oracleRefetchInterval } from "@/lib/api/polling";
import { qk } from "@/lib/api/query-keys";
import { replaceTemplateInPages } from "./mutations";
import {
  oracleResultQuery,
  oracleResultsQuery,
  oracleTemplateQuery,
  oracleTemplatesQuery,
  ORACLE_TEMPLATES_PAGE_SIZE,
} from "./queries";
import { readId } from "./schemas";
import type { OracleTemplate, OracleTemplatePage } from "./types";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

describe("oracle query keys", () => {
  it("spell their keys only through qk", () => {
    expect(oracleTemplateQuery("t1").queryKey).toEqual(qk.oracle.template("t1"));
    expect(oracleResultQuery("r1").queryKey).toEqual(qk.oracle.result("r1"));
    expect(oracleResultsQuery("t1").queryKey).toEqual(qk.oracle.results("t1"));
    expect(
      oracleTemplatesQuery({ targetId: "g", featureId: "f", approval: ["approved"] }).queryKey,
    ).toEqual(
      qk.oracle.templates({
        target_id: "g",
        feature_id: "f",
        approval: ["approved"],
        limit: ORACLE_TEMPLATES_PAGE_SIZE,
      }),
    );
  });

  it("key the template list by every filter so a filter change is a new query", () => {
    const base = oracleTemplatesQuery({ targetId: "g" }).queryKey;

    expect(oracleTemplatesQuery({ targetId: "g", approval: ["rejected"] }).queryKey).not.toEqual(
      base,
    );
    expect(oracleTemplatesQuery({ targetId: "h" }).queryKey).not.toEqual(base);
  });
});

describe("oracleResultQuery polling", () => {
  it("polls through the oracle profile and pauses in background tabs", () => {
    const options = oracleResultQuery("r1");

    expect(options.refetchInterval).toBe(oracleRefetchInterval);
    expect(options.refetchIntervalInBackground).toBe(false);
  });

  it("never goes stale once the result has settled and always is stale while it runs", () => {
    const staleTime = oracleResultQuery("r1").staleTime;
    if (typeof staleTime !== "function") {
      throw new Error("staleTime must be a function");
    }
    const queryWith = (data: unknown) => ({ state: { data } }) as never;

    expect(staleTime(queryWith({ status: "ok" }))).toBe(Infinity);
    expect(staleTime(queryWith({ status: "error" }))).toBe(Infinity);
    expect(staleTime(queryWith({ status: "pending" }))).toBe(0);
    expect(staleTime(queryWith(undefined))).toBe(0);
  });
});

describe("replaceTemplateInPages", () => {
  const template = (id: string, approval: OracleTemplate["approval"]): OracleTemplate => ({
    id,
    bundle_id: "b",
    name: id,
    feature_ids: [],
    language: "sql",
    source: "select 1",
    params_schema: {},
    sentence_template: "",
    read_only_verified: true,
    approval,
  });
  const page = (items: OracleTemplate[]): OracleTemplatePage => ({
    items,
    next_cursor: null,
    total: null,
  });

  it("replaces the matching template in every page and leaves the rest alone", () => {
    const data = {
      pages: [page([template("a", "unreviewed")]), page([template("b", "unreviewed")])],
      pageParams: [null, "next"],
    };

    const updated = replaceTemplateInPages(data, template("b", "approved"));

    expect(updated?.pages.map((entry) => entry.items.map((item) => item.approval))).toEqual([
      ["unreviewed"],
      ["approved"],
    ]);
    expect(updated?.pageParams).toEqual([null, "next"]);
  });

  it("passes undefined through", () => {
    expect(replaceTemplateInPages(undefined, template("a", "approved"))).toBeUndefined();
  });
});

describe("readId", () => {
  it("accepts a guid and rejects anything else", () => {
    expect(readId("0198f6f2-4c2a-7d10-9c1e-6a4f0d3ba001")).toBe(
      "0198f6f2-4c2a-7d10-9c1e-6a4f0d3ba001",
    );
    expect(readId("nope")).toBeNull();
    expect(readId(undefined)).toBeNull();
  });
});
