import { describe, expect, it } from "vitest";
import { formatUsd } from "./format-usd";

describe("formatUsd", () => {
  it.each([
    [0, "$0.00"],
    [5, "$5.00"],
    [0.42, "$0.42"],
    [0.0034, "$0.0034"],
    [1234.5, "$1,234.50"],
  ])("formats %d as %s", (value, expected) => {
    expect(formatUsd(value)).toBe(expected);
  });

  it("shows n/a instead of guessing when there is no number", () => {
    expect(formatUsd(null)).toBe("n/a");
    expect(formatUsd(undefined)).toBe("n/a");
    expect(formatUsd(Number.NaN)).toBe("n/a");
  });
});
