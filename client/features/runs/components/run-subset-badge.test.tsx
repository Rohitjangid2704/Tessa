import { describe, expect, it } from "vitest";
import { makeRun } from "@/tests/utils/run-detail-fixtures";
import { renderWithProviders, screen } from "@/tests/utils/render";
import { RunSubsetBadge } from "./run-subset-badge";

function subsetRun(ids: string[]) {
  const run = makeRun();
  return { ...run, config_snapshot: { ...run.config_snapshot, scenario_ids: ids } };
}

describe("RunSubsetBadge", () => {
  it("renders nothing for a full run", () => {
    renderWithProviders(<RunSubsetBadge run={makeRun()} />);
    expect(document.querySelector('[data-slot="run-subset"]')).toBeNull();
  });

  it("says what was skipped for a subset run", () => {
    renderWithProviders(<RunSubsetBadge run={subsetRun(["a", "b", "c"])} />);
    expect(screen.getByText("Subset: 3 scenarios")).toBeInTheDocument();
    expect(screen.getByText("Invariants and API fuzz skipped")).toBeInTheDocument();
  });

  it("uses the singular for one scenario", () => {
    renderWithProviders(<RunSubsetBadge run={subsetRun(["a"])} />);
    expect(screen.getByText("Subset: 1 scenario")).toBeInTheDocument();
  });
});
