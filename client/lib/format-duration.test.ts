import { describe, expect, it } from "vitest";
import { formatDuration } from "./format-duration";

describe("formatDuration", () => {
  it.each([
    [0, "0 s"],
    [999, "0 s"],
    [45_000, "45 s"],
    [61_000, "1 min 1 s"],
    [3_599_000, "59 min 59 s"],
    [3_720_000, "1 h 2 min"],
    [-5, "0 s"],
  ])("formats %d ms as %s", (milliseconds, expected) => {
    expect(formatDuration(milliseconds)).toBe(expected);
  });

  it("shows n/a when the duration is unknown", () => {
    expect(formatDuration(null)).toBe("n/a");
    expect(formatDuration(undefined)).toBe("n/a");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("n/a");
  });
});
