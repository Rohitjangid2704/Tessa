import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AUTHOR_SELECTION_NOTE,
  buildClaudeCodeCommand,
  MAX_AUTHOR_CELL_IDS,
  useClaudeCodeCommand,
} from "./use-claude-code-command";

const TARGET_TOKEN = "tgt_graciedemotoken";
const FINDING_ID = "0198f6f2-4c2a-7d10-9c1e-6a4f0d3b9a01";

function cellIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `cell-${index + 1}`);
}

describe("buildClaudeCodeCommand", () => {
  it.each([
    [
      "discover",
      buildClaudeCodeCommand("discover", { target_token: TARGET_TOKEN }),
      `/tessa:discover ${TARGET_TOKEN}`,
    ],
    [
      "explain",
      buildClaudeCodeCommand("explain", { finding_id: FINDING_ID }),
      `/tessa:explain ${FINDING_ID}`,
    ],
    [
      "author",
      buildClaudeCodeCommand("author", { cell_ids: ["c1", "c2", "c3"] }),
      "/tessa:author c1,c2,c3",
    ],
    ["mutants", buildClaudeCodeCommand("mutants"), "/tessa:mutants"],
    ["hooks", buildClaudeCodeCommand("hooks"), "/tessa:hooks"],
    ["propose", buildClaudeCodeCommand("propose"), "/tessa:propose"],
  ])("builds the %s command", (_template, result, expected) => {
    expect(result).toEqual({ command: expected, note: null });
  });

  it("lists exactly the cap of cell ids", () => {
    const ids = cellIds(MAX_AUTHOR_CELL_IDS);

    const result = buildClaudeCodeCommand("author", { cell_ids: ids });

    expect(result).toEqual({ command: `/tessa:author ${ids.join(",")}`, note: null });
  });

  it("drops the ids above the cap and points to the coverage selection", () => {
    const result = buildClaudeCodeCommand("author", {
      cell_ids: cellIds(MAX_AUTHOR_CELL_IDS + 1),
    });

    expect(result).toEqual({ command: "/tessa:author", note: AUTHOR_SELECTION_NOTE });
    expect(AUTHOR_SELECTION_NOTE).toContain("coverage selection");
  });

  it("falls back to the bare command when an argument is missing or blank", () => {
    expect(buildClaudeCodeCommand("discover").command).toBe("/tessa:discover");
    expect(buildClaudeCodeCommand("discover", { target_token: "  " }).command).toBe(
      "/tessa:discover",
    );
    expect(buildClaudeCodeCommand("author", { cell_ids: [] }).command).toBe("/tessa:author");
  });
});

describe("useClaudeCodeCommand", () => {
  it("returns the same result as the builder", () => {
    const { result } = renderHook(() =>
      useClaudeCodeCommand("explain", { finding_id: FINDING_ID }),
    );

    expect(result.current).toEqual({ command: `/tessa:explain ${FINDING_ID}`, note: null });
  });
});
