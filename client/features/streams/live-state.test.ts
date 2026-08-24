import { describe, expect, it } from "vitest";
import type { RunSocketStatus } from "@/lib/ws/socket";
import { toLiveState } from "./live-state";

describe("toLiveState", () => {
  it.each<[RunSocketStatus, string]>([
    ["live", "live"],
    ["connecting", "reconnecting"],
    ["reconnecting", "reconnecting"],
    ["resyncing", "reconnecting"],
    ["failed", "error"],
    ["closed", "closed"],
    ["idle", "closed"],
  ])("maps %s to %s", (status, expected) => {
    expect(toLiveState(status)).toBe(expected);
  });
});
