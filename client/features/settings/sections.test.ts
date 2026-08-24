import { describe, expect, it, vi } from "vitest";
import { canDo } from "@/lib/auth/can";
import { isPermissionId } from "@/lib/auth/permissions";
import type { UserRole } from "@/lib/auth/schemas";
import { settingsRoutes } from "@/lib/routes";
import { isSettingsSectionActive, isSettingsSectionVisible, SETTINGS_SECTIONS } from "./sections";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://localhost:8000";
});

function visibleIds(role: UserRole): string[] {
  return SETTINGS_SECTIONS.filter((section) =>
    isSettingsSectionVisible(section, (action) => canDo(role, action)),
  ).map((section) => section.id);
}

describe("settings sections", () => {
  it("lists every section once with a route of its own", () => {
    const ids = SETTINGS_SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(SETTINGS_SECTIONS.map((section) => section.href)).size).toBe(ids.length);
    expect(ids).toEqual([
      "general",
      "notifications",
      "schedules",
      "tokens",
      "users",
      "retention",
      "teams",
      "activity",
    ]);
  });

  it("gates the sections with real permission ids", () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(section.action === undefined || isPermissionId(section.action)).toBe(true);
    }
  });

  it("shows Activity to an admin only", () => {
    expect(visibleIds("admin")).toContain("activity");
    expect(visibleIds("member")).not.toContain("activity");
    expect(visibleIds("viewer")).not.toContain("activity");
  });

  it("shows personal tokens to every role", () => {
    for (const role of ["viewer", "member", "admin"] as const) {
      expect(visibleIds(role)).toContain("tokens");
    }
  });

  it("marks only the Activity section active on its route", () => {
    const active = SETTINGS_SECTIONS.filter((section) =>
      isSettingsSectionActive(section, settingsRoutes.activity()),
    ).map((section) => section.id);
    expect(active).toEqual(["activity"]);
  });
});
