import { describe, expect, it } from "vitest";
import { formatBytes } from "./format-bytes";

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [512, "512 B"],
    [1024, "1 KiB"],
    [1536, "1.5 KiB"],
    [26_214_400, "25 MiB"],
    [1_048_576, "1 MiB"],
    [27_000_000, "25.7 MiB"],
    [3 * 1024 ** 3, "3 GiB"],
  ])("formats %d as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it("does not guess for values that are not sizes", () => {
    expect(formatBytes(-1)).toBe("unknown size");
    expect(formatBytes(Number.NaN)).toBe("unknown size");
  });
});
