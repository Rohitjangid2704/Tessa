import type { Route } from "next";
import type { PermissionId } from "@/lib/auth/permissions";
import { settingsRoutes } from "@/lib/routes";

export type SettingsSectionId =
  | "general"
  | "notifications"
  | "schedules"
  | "users"
  | "retention"
  | "teams"
  | "tokens"
  | "activity";

export interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  href: Route;
  action?: PermissionId;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: "general", label: "General", href: settingsRoutes.root() },
  {
    id: "notifications",
    label: "Notifications",
    href: settingsRoutes.notifications(),
  },
  { id: "schedules", label: "Schedules", href: settingsRoutes.schedules() },
  { id: "tokens", label: "Personal tokens", href: settingsRoutes.tokens() },
  { id: "users", label: "Users", href: settingsRoutes.users(), action: "users.manage" },
  {
    id: "retention",
    label: "Retention",
    href: settingsRoutes.retention(),
    action: "retention.write",
  },
  { id: "teams", label: "Teams", href: settingsRoutes.teams(), action: "teams.manage" },
  { id: "activity", label: "Activity", href: settingsRoutes.activity(), action: "audit.read" },
];

export function isSettingsSectionVisible(
  section: SettingsSection,
  canDoAction: (action: PermissionId) => boolean,
): boolean {
  return section.action === undefined || canDoAction(section.action);
}

export function isSettingsSectionActive(section: SettingsSection, pathname: string): boolean {
  const base = settingsRoutes.root();
  if (section.href === base) {
    return pathname === base;
  }
  return pathname === section.href || pathname.startsWith(`${section.href}/`);
}
