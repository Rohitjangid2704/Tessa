import { describe, expect, it } from "vitest";
import type { ExplanationOpinion, ExplanationStructured } from "@/lib/api/types";
import { renderWithProviders, screen, within } from "@/tests/utils/render";
import {
  EXPLANATION_OPINION_PRESENTATION,
  ExplanationOpinionBadge,
} from "./explanation-opinion-badge";
import { formatStructuredFile, StructuredExplanationCard } from "./structured-explanation-card";

const FULL: ExplanationStructured = {
  opinion: "app_bug",
  root_cause: "The total is rounded per line before the tax is added.",
  files: [
    { path: "src/billing/invoice_totals.py", lines: "88-112" },
    { path: "tests/billing/test_totals.py", lines: null },
  ],
  commit: "9f3c2a1b7d8e4f60a5b1c2d3e4f5a6b7c8d9e0f1",
  fix_branch: "fix/rounding",
  confidence: "high",
};

const HOSTILE = '<img src=x onerror="window.__pwned = true">';

describe("StructuredExplanationCard", () => {
  it("shows the opinion, root cause, files, commit, fix branch and confidence", () => {
    renderWithProviders(<StructuredExplanationCard structured={FULL} />);

    expect(screen.getByText("App bug")).toBeInTheDocument();
    expect(screen.getByText("High confidence")).toBeInTheDocument();
    expect(screen.getByText(FULL.root_cause)).toBeInTheDocument();
    const files = screen.getByRole("list", { name: "Files" });
    expect(
      within(files)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["src/billing/invoice_totals.py:88-112", "tests/billing/test_totals.py"]);
    expect(screen.getByText(FULL.commit as string)).toBeInTheDocument();
    expect(screen.getByText("fix/rounding")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy commit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy fix branch" })).toBeInTheDocument();
  });

  it("omits the commit block when neither commit nor fix branch is given", () => {
    renderWithProviders(
      <StructuredExplanationCard structured={{ ...FULL, commit: null, fix_branch: undefined }} />,
    );

    expect(screen.queryByText("Commit")).not.toBeInTheDocument();
    expect(screen.queryByText("Fix branch")).not.toBeInTheDocument();
  });

  it("says so when no file is named", () => {
    renderWithProviders(<StructuredExplanationCard structured={{ ...FULL, files: [] }} />);

    expect(screen.getByText("No files named.")).toBeInTheDocument();
  });

  it("keeps a long file list in a scrollable region", () => {
    const files = Array.from({ length: 30 }, (_, index) => ({
      path: `src/file_${index}.py`,
      lines: `${index}-${index + 5}`,
    }));
    renderWithProviders(<StructuredExplanationCard structured={{ ...FULL, files }} />);

    const list = screen.getByRole("list", { name: "Files" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(30);
    expect(list).toHaveClass("overflow-y-auto");
    expect(list).toHaveAttribute("tabindex", "0");
  });

  it("renders every field as text and never as HTML", () => {
    const { container } = renderWithProviders(
      <StructuredExplanationCard
        structured={{
          ...FULL,
          root_cause: HOSTILE,
          files: [{ path: HOSTILE, lines: HOSTILE }],
          commit: HOSTILE,
          fix_branch: HOSTILE,
        }}
      />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(HOSTILE, { selector: "p" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Files" })).toHaveTextContent(`${HOSTILE}:${HOSTILE}`);
    expect(screen.getAllByText(HOSTILE, { selector: "span" })).toHaveLength(2);
    expect("__pwned" in window).toBe(false);
  });
});

describe("ExplanationOpinionBadge", () => {
  const opinions: ExplanationOpinion[] = ["app_bug", "scenario_bug", "harness", "unknown"];

  it.each(opinions)("shows %s with an icon and its text label", (opinion) => {
    renderWithProviders(<ExplanationOpinionBadge opinion={opinion} />);

    const badge = screen.getByText(EXPLANATION_OPINION_PRESENTATION[opinion].label);
    expect(badge.closest("[data-slot='status-badge']")?.querySelector("svg")).not.toBeNull();
    expect(badge.closest("[data-opinion]")).toHaveAttribute("data-opinion", opinion);
  });

  it("maps the four opinions to danger, warning, info and muted tones", () => {
    expect(opinions.map((opinion) => EXPLANATION_OPINION_PRESENTATION[opinion].tone)).toEqual([
      "verdict-fail",
      "verdict-flaky",
      "severity-info",
      "verdict-skipped",
    ]);
  });
});

describe("formatStructuredFile", () => {
  it("joins the path and the line range with a colon", () => {
    expect(formatStructuredFile({ path: "a.py", lines: "3-9" })).toBe("a.py:3-9");
    expect(formatStructuredFile({ path: "a.py", lines: null })).toBe("a.py");
    expect(formatStructuredFile({ path: "a.py" })).toBe("a.py");
  });
});
