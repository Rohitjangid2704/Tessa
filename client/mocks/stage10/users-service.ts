import type { User } from "@/lib/api/types";
import type { PageSpec } from "../factories/pagination";
import type { MockUser, UserRole } from "../types";
import type { UserProfile } from "./users-data";
import type { UsersStore } from "./users-store";

export const USER_ROLES = ["viewer", "member", "admin"] as const satisfies readonly UserRole[];

export const USER_NAME_MAX = 120;
export const USER_EMAIL_MAX = 320;
export const USER_PASSWORD_MIN = 12;
export const USER_PASSWORD_MAX = 1024;
export const USER_SEARCH_MAX = 200;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLE_RANK: Record<UserRole, number> = { viewer: 0, member: 1, admin: 2 };

export interface UserRow {
  user: MockUser;
  profile: UserProfile;
}

export function toUser({ user, profile }: UserRow): User {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    is_active: user.isActive,
    team_ids: [...profile.teamIds],
    created_at: profile.createdAt,
    last_login_at: profile.lastLoginAt,
  };
}

export function rowsOf(users: readonly MockUser[], store: UsersStore): UserRow[] {
  return users.map((user) => ({ user, profile: store.profileOf(user.id) }));
}

export const USER_PAGE: PageSpec<UserRow> = {
  sortKeys: {
    name: { kind: "text", value: (row) => row.user.name },
    email: { kind: "text", value: (row) => row.user.email },
    created_at: { kind: "timestamp", value: (row) => row.profile.createdAt },
    last_login_at: { kind: "timestamp", value: (row) => row.profile.lastLoginAt ?? "" },
  },
  defaultSort: "-created_at",
  getId: (row) => row.user.id,
};

export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value);
}

export function matchesSearch(row: UserRow, needle: string): boolean {
  return (
    row.user.name.toLowerCase().includes(needle) || row.user.email.toLowerCase().includes(needle)
  );
}

export function activeAdminCount(users: readonly MockUser[]): number {
  return users.filter((user) => user.role === "admin" && user.isActive).length;
}

export function isRoleLowered(from: UserRole, to: UserRole): boolean {
  return ROLE_RANK[to] < ROLE_RANK[from];
}
