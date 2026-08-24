import { describe, expect, it } from "vitest";
import { makeRun } from "@/tests/utils/run-detail-fixtures";
import { subsetScenarioIds } from "./run-subset";

function runWithSnapshot(extra: Record<string, unknown>) {
  const run = makeRun();
  return { config_snapshot: { ...run.config_snapshot, ...extra } };
}

describe("subsetScenarioIds", () => {
  it("is null for a full run", () => {
    expect(subsetScenarioIds(makeRun())).toBeNull();
  });

  it("returns the pinned scenario ids of a subset run", () => {
    expect(subsetScenarioIds(runWithSnapshot({ scenario_ids: ["a", "b"] }))).toEqual(["a", "b"]);
  });

  it.each([[[]], [null], ["a"], [[1, 2]]])("treats %j as not a subset", (value) => {
    expect(subsetScenarioIds(runWithSnapshot({ scenario_ids: value }))).toBeNull();
  });
});
