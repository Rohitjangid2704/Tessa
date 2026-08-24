import type { UserRole } from "@/lib/auth/schemas";

export const ROLE_LABELS: Record<UserRole, string> = {
  viewer: "Viewer",
  member: "Member",
  admin: "Admin",
};

export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  viewer: "Read only. Can browse targets, runs, findings and settings but change nothing.",
  member:
    "Can create targets, plans and runs, label verdicts and triage findings. Cannot change settings, users or secrets.",
  admin:
    "Everything a member can do, plus users, retention, teams, settings, secrets and production switches.",
};

export const ACTIVE_STATE_LABELS = {
  active: "Active",
  inactive: "Deactivated",
} as const;

export const ACTIVE_FILTER_LABELS = {
  true: "Active",
  false: "Deactivated",
} as const;

export const SELF_ACTION_REASON =
  "This is your own account. Ask another admin to change your role or deactivate you.";

export const LAST_ADMIN_REASON =
  "This is the last active admin. Make another user an admin before changing this one.";

export const GATE_PENDING_REASON = "Checking who you are and how many admins there are.";

export const NO_PASSWORD_NOTE =
  "Leave the password empty to create an SSO-only account. That person can only sign in through Tessa SSO and cannot use a password.";

export const ADMIN_ONLY_USERS_MESSAGE = "Only admins can manage users.";

export const SINGLE_USER_TITLE = "You are the only user";

export const SINGLE_USER_DESCRIPTION =
  "Create accounts for your teammates, or let them sign in through SSO and they appear here.";
