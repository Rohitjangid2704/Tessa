import { describe, expect, it } from "vitest";
import {
  labelRoutes,
  loginHref,
  loginPath,
  oracleRoutes,
  routes,
  runRoutes,
  scenarioRoutes,
  seedRoutes,
  targetRoutes,
  toRoute,
  withQuery,
} from "./routes";

describe("loginPath", () => {
  it("is the bare login route without a callback", () => {
    expect(loginPath()).toBe("/login");
    expect(loginPath(null)).toBe("/login");
    expect(loginPath("/")).toBe("/login");
  });

  it("carries a safe callback as an encoded query", () => {
    expect(loginPath("/runs?tab=events")).toBe("/login?callbackUrl=%2Fruns%3Ftab%3Devents");
  });

  it("drops unsafe callbacks", () => {
    expect(loginPath("//evil.example")).toBe("/login");
    expect(loginPath("https://evil.example")).toBe("/login");
    expect(loginPath("/login?callbackUrl=/runs")).toBe("/login");
  });

  it("matches loginHref", () => {
    expect(loginHref("/catalog")).toBe(loginPath("/catalog"));
  });
});

describe("withQuery", () => {
  it("skips empty values and encodes the rest", () => {
    expect(
      withQuery("/catalog", { target_id: "abc", tab: undefined, q: null, n: 2, a: "x y" }),
    ).toBe("/catalog?target_id=abc&n=2&a=x+y");
    expect(withQuery("/runs")).toBe("/runs");
    expect(withQuery("/runs", { tab: undefined })).toBe("/runs");
  });
});

describe("routes", () => {
  it("names the nav pages in contract order", () => {
    expect([
      routes.home,
      routes.targets,
      routes.catalog,
      routes.scenarios,
      routes.runs,
      routes.findings,
      routes.labels,
      routes.explore,
      routes.settings,
    ]).toEqual([
      "/",
      "/targets",
      "/catalog",
      "/scenarios",
      "/runs",
      "/findings",
      "/labels",
      "/explore",
      "/settings",
    ]);
    expect(routes.apiToken).toBe("/api/session/api-token");
    expect(toRoute("/runs")).toBe("/runs");
  });
});

describe("targetRoutes", () => {
  it("builds the target pages", () => {
    expect(targetRoutes.list()).toBe("/targets");
    expect(targetRoutes.create()).toBe("/targets/new");
    expect(targetRoutes.detail("t1")).toBe("/targets/t1");
    expect(targetRoutes.bundles("t1")).toBe("/targets/t1/bundles");
    expect(targetRoutes.bundle("t1", "b2")).toBe("/targets/t1/bundles/b2");
    expect(targetRoutes.environment("t1")).toBe("/targets/t1/environment");
  });

  it("builds the catalog link of a target", () => {
    expect(targetRoutes.catalog("t1")).toBe("/catalog?target_id=t1");
  });
});

describe("runRoutes", () => {
  it("builds the runs list with filters in the query", () => {
    expect(runRoutes.list()).toBe("/runs");
    expect(runRoutes.list({ target_id: "t1", status: "running", kind: undefined })).toBe(
      "/runs?target_id=t1&status=running",
    );
  });

  it("builds the run detail and the step page of a run", () => {
    expect(runRoutes.detail("r1")).toBe("/runs/r1");
    expect(runRoutes.step("r1", "s9")).toBe("/runs/r1/steps/s9");
  });
});

describe("scenarioRoutes", () => {
  it("builds the library with filters and the detail page", () => {
    expect(scenarioRoutes.list()).toBe("/scenarios");
    expect(scenarioRoutes.list({ target_id: "t1", include_synthetic: true })).toBe(
      "/scenarios?target_id=t1&include_synthetic=true",
    );
    expect(scenarioRoutes.detail("sc1")).toBe("/scenarios/sc1");
  });
});

describe("seedRoutes and oracleRoutes", () => {
  it("builds the truth pages for a target", () => {
    expect(seedRoutes.list("t1")).toBe("/seeds?target_id=t1");
    expect(seedRoutes.list()).toBe("/seeds");
    expect(seedRoutes.list(null)).toBe("/seeds");
    expect(oracleRoutes.list("t1")).toBe("/oracle?target_id=t1");
    expect(oracleRoutes.list()).toBe("/oracle");
    expect(oracleRoutes.template("t1", "o1")).toBe("/oracle?target_id=t1&template_id=o1");
  });

  it("names the seeds and oracle pages", () => {
    expect(routes.seeds).toBe("/seeds");
    expect(routes.oracle).toBe("/oracle");
  });
});

describe("labelRoutes", () => {
  it("builds the review queue with optional filters", () => {
    expect(labelRoutes.queue()).toBe("/labels");
    expect(labelRoutes.queue({ reason: "uncertain", target_id: "t1" })).toBe(
      "/labels?reason=uncertain&target_id=t1",
    );
  });
});
