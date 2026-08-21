import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HEALTH_STATUSES } from "./status-types";
import { HealthTick } from "./health-tick";

const NAMES = {
  ok: "OK",
  failed: "Failed",
  skipped: "Skipped",
  unchecked: "Unchecked",
} as const;

describe("HealthTick", () => {
  it.each(HEALTH_STATUSES)("names the %s state in words, not by color alone", (status) => {
    render(<HealthTick status={status} />);

    expect(screen.getByText(NAMES[status])).toBeVisible();
  });

  it("covers every health status", () => {
    expect(Object.keys(NAMES).sort()).toEqual([...HEALTH_STATUSES].sort());
  });

  it("hides the icon from assistive technology so the name is the text only", () => {
    const { container } = render(<HealthTick status="failed" />);

    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(container.textContent).toBe("Failed");
  });

  it("uses a distinct tone for each state", () => {
    const tones = HEALTH_STATUSES.map((status) => {
      const { container, unmount } = render(<HealthTick status={status} />);
      const tone = container.querySelector("[data-slot=status-badge]")?.getAttribute("data-tone");
      unmount();
      return tone;
    });

    expect(tones).toEqual(["hollow", "verdict-pass", "verdict-fail", "verdict-skipped"]);
  });

  it("passes extra attributes to the badge", () => {
    render(<HealthTick status="ok" data-interface="rest_api" />);

    expect(screen.getByText("OK").closest("[data-slot=status-badge]")).toHaveAttribute(
      "data-interface",
      "rest_api",
    );
  });
});
