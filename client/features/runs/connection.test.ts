import { describe, expect, it } from "vitest";
import type { RunStatus } from "@/lib/api/types";
import type { RunSocketStatus } from "@/lib/ws/socket";
import { describeConnection, describeRunAnnouncement } from "./connection";

describe("describeConnection", () => {
  it.each([
    ["live", "live", "Live", "none"],
    ["connecting", "reconnecting", "Connecting", "none"],
    ["reconnecting", "reconnecting", "Reconnecting", "reconnecting"],
    ["resyncing", "reconnecting", "Resyncing", "resyncing"],
    ["failed", "error", "Offline", "failed"],
    ["idle", "closed", "Closed", "none"],
    ["closed", "closed", "Closed", "none"],
  ] as const)("maps socket status %s", (status, liveState, label, banner) => {
    const view = describeConnection({ status: status as RunSocketStatus, isTerminal: false });

    expect(view).toMatchObject({ liveState, label, banner });
  });

  it("shows a terminal run as not live whatever the socket says and never shows a banner", () => {
    for (const status of [
      "live",
      "reconnecting",
      "resyncing",
      "failed",
      "closed",
      "idle",
    ] as const) {
      expect(describeConnection({ status, isTerminal: true })).toEqual({
        liveState: "closed",
        label: "Not live",
        banner: "none",
        announcement: null,
      });
    }
  });

  it("has an announcement for connected, reconnecting, resyncing and failed only", () => {
    const announced = (["live", "reconnecting", "resyncing", "failed"] as const).map(
      (status) => describeConnection({ status, isTerminal: false }).announcement,
    );

    expect(announced.every((text) => typeof text === "string" && text.length > 0)).toBe(true);
    expect(describeConnection({ status: "connecting", isTerminal: false }).announcement).toBeNull();
    expect(describeConnection({ status: "closed", isTerminal: false }).announcement).toBeNull();
  });
});

describe("describeRunAnnouncement", () => {
  it("joins the run status and the connection announcement", () => {
    const live = describeConnection({ status: "live", isTerminal: false });

    expect(describeRunAnnouncement("running", live)).toBe("Run running. Live updates connected");
  });

  it("is only the run status when the connection has nothing to say", () => {
    const terminal = describeConnection({ status: "closed", isTerminal: true });

    expect(describeRunAnnouncement("completed", terminal)).toBe("Run completed");
  });

  it.each<[RunStatus, string]>([
    ["queued", "Run queued"],
    ["canceling", "Run canceling"],
    ["budget_exceeded", "Run stopped, budget exceeded"],
    ["failed", "Run failed"],
  ])("words %s plainly", (status, expected) => {
    const terminal = describeConnection({ status: "closed", isTerminal: true });

    expect(describeRunAnnouncement(status, terminal)).toBe(expected);
  });
});
