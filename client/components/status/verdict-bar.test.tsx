import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VerdictBar } from "./verdict-bar";

const counters = {
  scenarios_total: 12,
  scenarios_done: 5,
  pass: 3,
  fail: 1,
  flaky: 0,
  uncertain: 1,
  skipped: 0,
};

describe("VerdictBar", () => {
  it("lists every verdict with its count in a labelled list", () => {
    render(<VerdictBar counters={counters} />);

    const list = screen.getByRole("list", { name: "Verdict counters" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Pass3",
      "Fail1",
      "Flaky0",
      "Uncertain1",
      "Skipped0",
    ]);
  });

  it("marks empty counters as hollow and keeps uncertain out of the pass tone", () => {
    render(<VerdictBar counters={counters} />);

    const flaky = document.querySelector('[data-verdict="flaky"]');
    const uncertain = document.querySelector('[data-verdict="uncertain"]');
    const pass = document.querySelector('[data-verdict="pass"]');
    expect(flaky?.className).toContain("border-dashed");
    expect(uncertain?.className).toContain("verdict-uncertain");
    expect(uncertain?.className).not.toContain("verdict-pass");
    expect(pass?.className).toContain("verdict-pass");
  });

  it("hides zero counters on request and can show scenario progress", () => {
    render(<VerdictBar counters={counters} hideZero showProgress />);

    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "5 of 12 scenarios done",
      "Pass3",
      "Fail1",
      "Uncertain1",
    ]);
  });
});
