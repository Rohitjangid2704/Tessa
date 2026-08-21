import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "@/tests/utils/render";
import { RunTriggerBadge, type RunTriggerValue } from "./run-trigger";

const CASES: Array<[RunTriggerValue, string, string]> = [
  ["manual", "Manual", "hollow"],
  ["schedule", "Scheduled", "hollow"],
  ["api", "API", "hollow"],
  ["agent", "From Claude Code", "tier-laya"],
];

describe("RunTriggerBadge", () => {
  it.each(CASES)("renders %s as %s with text and an icon", (trigger, label, tone) => {
    renderWithProviders(<RunTriggerBadge trigger={trigger} />);
    const badge = screen.getByText(label);
    expect(badge).toHaveAttribute("data-tone", tone);
    expect(badge).toHaveAttribute("data-trigger", trigger);
    expect(badge.querySelector("svg")).not.toBeNull();
  });

  it("explains the agent origin in its title", () => {
    renderWithProviders(<RunTriggerBadge trigger="agent" />);
    expect(screen.getByText("From Claude Code")).toHaveAttribute(
      "title",
      "Started from Claude Code with a personal token",
    );
  });
});
