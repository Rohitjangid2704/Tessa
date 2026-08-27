import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { hasWindowsAbortBug, runtimeAdvisory } from "../src/runtime";

const here = dirname(fileURLToPath(import.meta.url));
const hookCommon = (await import(pathToFileURL(join(resolve(here, "..", ".."), "scripts", "hook-common.mjs")).href)) as {
  runtimeAdvisory: (nodeVersion: string, platform: string) => string | null;
};

const CASES: Array<[string, string, boolean]> = [
  ["v24.15.0", "win32", true],
  ["v24.19.0", "win32", true],
  ["v24.20.0", "win32", false],
  ["v24.22.0", "win32", false],
  ["v23.11.0", "win32", true],
  ["v25.9.0", "win32", true],
  ["v22.23.3", "win32", false],
  ["v26.12.0", "win32", false],
  ["v24.15.0", "linux", false],
  ["v24.15.0", "darwin", false],
];

describe("the Windows abort of Node before 24.20.0", () => {
  it.each(CASES)("%s on %s is affected: %s", (version, platform, affected) => {
    expect(hasWindowsAbortBug(version, platform)).toBe(affected);
    const advisory = runtimeAdvisory(version, platform);
    expect(advisory === null).toBe(!affected);
    if (advisory !== null) {
      expect(advisory).toContain(version);
      expect(advisory).toContain("24.20.0");
      expect(advisory).toContain("3221226505");
    }
  });

  it.each(CASES)("the SessionStart hook says the same for %s on %s", (version, platform) => {
    expect(hookCommon.runtimeAdvisory(version, platform)).toBe(runtimeAdvisory(version, platform));
  });
});
