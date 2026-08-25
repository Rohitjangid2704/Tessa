import { ADMIN_USER, INACTIVE_USER, MEMBER_USER, VIEWER_USER } from "../factories/users";
import { stableId } from "../stage2/ids";
import type { MockUser, UserRole } from "../types";

export const STAGE_TEN_TEAM_IDS = {
  platform: stableId("seed_team", "platform"),
  growth: stableId("seed_team", "growth"),
  mobile: stableId("seed_team", "mobile"),
} as const;

export interface UserProfile {
  createdAt: string;
  lastLoginAt: string | null;
  teamIds: string[];
}

export interface SeededAccount {
  user: MockUser;
  profile: UserProfile;
}

interface ExtraUserSpec {
  key: string;
  name: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  signsInWithPassword: boolean;
  teamIds: readonly string[];
  createdAt: string;
  lastLoginAt: string | null;
}

const BULK_USER_COUNT = 60;
const BULK_FIRST_CREATED_AT_MS = Date.parse("2026-08-10T09:00:00.000Z");
const HOUR_MS = 3_600_000;
const BULK_INACTIVE_EVERY = 7;
const BULK_TEAM_ROTATION = [
  [STAGE_TEN_TEAM_IDS.platform],
  [STAGE_TEN_TEAM_IDS.growth],
  [STAGE_TEN_TEAM_IDS.mobile, STAGE_TEN_TEAM_IDS.platform],
  [],
] as const;

export const SEEDED_USER_IDS = {
  admin: ADMIN_USER.id,
  member: MEMBER_USER.id,
  viewer: VIEWER_USER.id,
  inactive: INACTIVE_USER.id,
  secondAdmin: stableId("seed_user", "second_admin"),
  ssoMember: stableId("seed_user", "sso_member"),
  ssoViewer: stableId("seed_user", "sso_viewer"),
  deactivatedViewer: stableId("seed_user", "deactivated_viewer"),
} as const;

const BASE_PROFILES: ReadonlyArray<{ user: MockUser; profile: UserProfile }> = [
  {
    user: ADMIN_USER,
    profile: {
      createdAt: "2026-06-01T08:00:00.000Z",
      lastLoginAt: "2026-10-06T07:45:00.000Z",
      teamIds: [STAGE_TEN_TEAM_IDS.platform],
    },
  },
  {
    user: MEMBER_USER,
    profile: {
      createdAt: "2026-06-01T08:05:00.000Z",
      lastLoginAt: "2026-10-05T16:20:00.000Z",
      teamIds: [STAGE_TEN_TEAM_IDS.platform, STAGE_TEN_TEAM_IDS.growth],
    },
  },
  {
    user: VIEWER_USER,
    profile: {
      createdAt: "2026-06-02T09:00:00.000Z",
      lastLoginAt: "2026-10-01T10:00:00.000Z",
      teamIds: [],
    },
  },
  {
    user: INACTIVE_USER,
    profile: {
      createdAt: "2026-06-02T09:10:00.000Z",
      lastLoginAt: "2026-07-15T12:00:00.000Z",
      teamIds: [],
    },
  },
];

const EXTRA_USERS: readonly ExtraUserSpec[] = [
  {
    key: "second_admin",
    name: "Dana Whitfield",
    email: "dana.whitfield@tessa.local",
    role: "admin",
    isActive: true,
    signsInWithPassword: true,
    teamIds: [STAGE_TEN_TEAM_IDS.platform],
    createdAt: "2026-06-20T10:00:00.000Z",
    lastLoginAt: "2026-10-04T13:10:00.000Z",
  },
  {
    key: "sso_member",
    name: "Aiko Tanaka",
    email: "aiko.tanaka@tessa.local",
    role: "member",
    isActive: true,
    signsInWithPassword: false,
    teamIds: [STAGE_TEN_TEAM_IDS.mobile],
    createdAt: "2026-07-08T11:30:00.000Z",
    lastLoginAt: "2026-10-05T09:02:00.000Z",
  },
  {
    key: "sso_viewer",
    name: "Tomas Herrera",
    email: "tomas.herrera@tessa.local",
    role: "viewer",
    isActive: true,
    signsInWithPassword: false,
    teamIds: [STAGE_TEN_TEAM_IDS.growth, STAGE_TEN_TEAM_IDS.mobile],
    createdAt: "2026-07-22T15:45:00.000Z",
    lastLoginAt: null,
  },
  {
    key: "deactivated_viewer",
    name: "Samir Haddad",
    email: "samir.haddad@tessa.local",
    role: "viewer",
    isActive: false,
    signsInWithPassword: true,
    teamIds: [],
    createdAt: "2026-07-30T08:15:00.000Z",
    lastLoginAt: "2026-08-19T17:40:00.000Z",
  },
];

function cloneUser(user: MockUser): MockUser {
  return { ...user };
}

function toAccount(spec: ExtraUserSpec): SeededAccount {
  return {
    user: {
      id: stableId("seed_user", spec.key),
      email: spec.email,
      name: spec.name,
      role: spec.role,
      password: spec.signsInWithPassword ? `dev-only-${spec.key}-password-1` : "",
      isActive: spec.isActive,
    },
    profile: {
      createdAt: spec.createdAt,
      lastLoginAt: spec.lastLoginAt,
      teamIds: [...spec.teamIds],
    },
  };
}

function bulkAccount(index: number): SeededAccount {
  const label = String(index + 1).padStart(2, "0");
  const createdAtMs = BULK_FIRST_CREATED_AT_MS + index * HOUR_MS;
  const rotation = BULK_TEAM_ROTATION[index % BULK_TEAM_ROTATION.length] ?? [];
  return {
    user: {
      id: stableId("seed_user", "bulk", index),
      email: `bulk.user${label}@tessa.local`,
      name: `Bulk User ${label}`,
      role: index % 3 === 0 ? "member" : "viewer",
      password: "",
      isActive: (index + 1) % BULK_INACTIVE_EVERY !== 0,
    },
    profile: {
      createdAt: new Date(createdAtMs).toISOString(),
      lastLoginAt: index % 2 === 0 ? new Date(createdAtMs + 5 * HOUR_MS).toISOString() : null,
      teamIds: [...rotation],
    },
  };
}

export function baseAccounts(): SeededAccount[] {
  return BASE_PROFILES.map(({ user, profile }) => ({
    user: cloneUser(user),
    profile: { ...profile, teamIds: [...profile.teamIds] },
  }));
}

export function defaultAccounts(): SeededAccount[] {
  return [...baseAccounts(), ...EXTRA_USERS.map(toAccount)];
}

export function manyAccounts(): SeededAccount[] {
  return [
    ...defaultAccounts(),
    ...Array.from({ length: BULK_USER_COUNT }, (_unused, index) => bulkAccount(index)),
  ];
}

export function singleAccount(): SeededAccount[] {
  return baseAccounts().filter(({ user }) => user.id === ADMIN_USER.id);
}
