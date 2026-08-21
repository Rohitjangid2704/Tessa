import { describe, expect, it } from "vitest";
import { NAV_GROUPS, NAV_ITEMS, isNavItemActive, navHref } from "./nav-items";

const catalog = NAV_ITEMS.find((item) => item.id === "catalog");
const targets = NAV_ITEMS.find((item) => item.id === "targets");
const oracle = NAV_ITEMS.find((item) => item.id === "oracle");

const planItems = NAV_ITEMS.filter((item) => item.group !== "truth");

describe("NAV_ITEMS", () => {
  it("lists the eight pages in the contract order after Home", () => {
    expect(planItems.map((item) => item.label)).toEqual([
      "Targets",
      "Catalog",
      "Scenarios",
      "Runs",
      "Findings",
      "Labels",
      "Explore",
      "Settings",
    ]);
    expect(planItems.map((item) => item.href)).toEqual([
      "/targets",
      "/catalog",
      "/scenarios",
      "/runs",
      "/findings",
      "/labels",
      "/explore",
      "/settings",
    ]);
  });

  it("adds Seeds and Oracle as the Truth group, both carrying the target", () => {
    const truth = NAV_ITEMS.filter((item) => item.group === "truth");

    expect(truth.map((item) => [item.label, item.href, item.carriesTarget])).toEqual([
      ["Seeds", "/seeds", true],
      ["Oracle", "/oracle", true],
    ]);
  });

  it("keeps ids and hrefs unique", () => {
    expect(new Set(NAV_ITEMS.map((item) => item.id)).size).toBe(NAV_ITEMS.length);
    expect(new Set(NAV_ITEMS.map((item) => item.href)).size).toBe(NAV_ITEMS.length);
  });
});

describe("NAV_GROUPS", () => {
  it("splits the items into workspace, a labelled Truth group and system, in display order", () => {
    expect(NAV_GROUPS.map((group) => [group.id, group.label, group.items.length])).toEqual([
      ["workspace", null, 7],
      ["truth", "Truth", 2],
      ["system", null, 1],
    ]);
    expect(NAV_GROUPS.flatMap((group) => group.items)).toEqual(NAV_ITEMS);
  });
});

describe("isNavItemActive", () => {
  it("matches Home only on the root path", () => {
    expect(isNavItemActive("/", "/")).toBe(true);
    expect(isNavItemActive("/", "/runs")).toBe(false);
  });

  it("matches a page on its own path and on nested paths", () => {
    expect(isNavItemActive("/runs", "/runs")).toBe(true);
    expect(isNavItemActive("/runs", "/runs/0198f6f2-4c2a")).toBe(true);
    expect(isNavItemActive("/runs", "/runs/0198f6f2-4c2a/steps/3")).toBe(true);
  });

  it("does not match a sibling that shares a prefix", () => {
    expect(isNavItemActive("/run", "/runs")).toBe(false);
    expect(isNavItemActive("/targets", "/targets-archive")).toBe(false);
    expect(isNavItemActive("/settings", "/scenarios")).toBe(false);
  });
});

describe("navHref", () => {
  it("returns the plain path when no target is remembered", () => {
    expect(catalog && navHref(catalog)).toBe("/catalog");
    expect(catalog && navHref(catalog, null)).toBe("/catalog");
  });

  it("adds target_id to the pages that take a target", () => {
    expect(catalog && navHref(catalog, "0198f6f2-4c2a")).toBe("/catalog?target_id=0198f6f2-4c2a");
    expect(oracle && navHref(oracle, "0198f6f2-4c2a")).toBe("/oracle?target_id=0198f6f2-4c2a");
  });

  it("never adds target_id to Targets and Settings", () => {
    const settings = NAV_ITEMS.find((item) => item.id === "settings");
    expect(targets && navHref(targets, "0198f6f2-4c2a")).toBe("/targets");
    expect(settings && navHref(settings, "0198f6f2-4c2a")).toBe("/settings");
  });
});
