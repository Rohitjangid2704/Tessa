import { describe, expect, it } from "vitest";
import {
  agentSessionState,
  pluralizeWrites,
  SESSION_SUMMARY_PREVIEW_CHARS,
  summaryNeedsExpander,
} from "./sessions";

describe("agentSessionState", () => {
  it("reads an ended session as ended whatever the active flag says", () => {
    expect(agentSessionState({ ended_at: "2026-10-09T10:00:00Z", active: false })).toBe("ended");
    expect(agentSessionState({ ended_at: "2026-10-09T10:00:00Z", active: true })).toBe("ended");
  });

  it("reads an open session as active", () => {
    expect(agentSessionState({ ended_at: null, active: true })).toBe("active");
  });

  it("reads an open session older than twelve hours as inactive", () => {
    expect(agentSessionState({ ended_at: null, active: false })).toBe("inactive");
  });
});

describe("summary helpers", () => {
  it("offers the expander only for a long summary", () => {
    expect(summaryNeedsExpander(null)).toBe(false);
    expect(summaryNeedsExpander("short")).toBe(false);
    expect(summaryNeedsExpander("x".repeat(SESSION_SUMMARY_PREVIEW_CHARS))).toBe(false);
    expect(summaryNeedsExpander("x".repeat(SESSION_SUMMARY_PREVIEW_CHARS + 1))).toBe(true);
  });

  it("counts writes", () => {
    expect(pluralizeWrites(0)).toBe("0 writes");
    expect(pluralizeWrites(1)).toBe("1 write");
    expect(pluralizeWrites(7)).toBe("7 writes");
  });
});
