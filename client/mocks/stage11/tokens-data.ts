import { randomBytes } from "node:crypto";
import type { PersonalToken } from "@/lib/api/types";
import { ADMIN_USER, MEMBER_USER, VIEWER_USER } from "../factories/users";
import { newId } from "../factories/ids";

export const TOKEN_PREFIX = "ipt_";
export const TOKEN_SECRET_BODY_LENGTH = 43;
export const TOKEN_DISPLAY_PREFIX_LENGTH = 8;
export const TOKEN_LIMIT = 10;
export const TOKEN_MAX_DAYS = 90;
export const TOKEN_NAME_MAX = 60;

export const TOKEN_VARIANTS = ["none", "full", "expired"] as const;

export type TokensVariant = (typeof TOKEN_VARIANTS)[number];

export interface TokenRecord {
  userId: string;
  secret: string;
  token: PersonalToken;
}

const DAY_MS = 86_400_000;
const SEEDED_USER_IDS = [ADMIN_USER.id, MEMBER_USER.id, VIEWER_USER.id];
const FULL_TOKEN_NAMES = [
  "laptop",
  "desktop",
  "ci runner",
  "gracie repo",
  "billing repo",
  "review box",
  "nightly propose",
  "demo",
  "pairing",
  "scratch",
];

export function mintSecret(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function isPersonalTokenSecret(value: string): boolean {
  return (
    value.startsWith(TOKEN_PREFIX) &&
    value.length === TOKEN_PREFIX.length + TOKEN_SECRET_BODY_LENGTH
  );
}

export function displayPrefix(secret: string): string {
  return secret.slice(0, TOKEN_DISPLAY_PREFIX_LENGTH);
}

export function buildRecord(
  userId: string,
  name: string,
  now: number,
  overrides: Partial<PersonalToken> = {},
): TokenRecord {
  const secret = mintSecret();
  return {
    userId,
    secret,
    token: {
      id: newId(now),
      name,
      prefix: displayPrefix(secret),
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + TOKEN_MAX_DAYS * DAY_MS).toISOString(),
      last_used_at: null,
      revoked_at: null,
      state: "active",
      user_id: userId,
      ...overrides,
    },
  };
}

function fullRecords(userId: string, now: number): TokenRecord[] {
  return FULL_TOKEN_NAMES.map((name, index) =>
    buildRecord(userId, name, now - (index + 1) * DAY_MS, {
      last_used_at: index % 2 === 0 ? new Date(now - index * 3_600_000).toISOString() : null,
    }),
  );
}

function expiredRecords(userId: string, now: number): TokenRecord[] {
  return [
    buildRecord(userId, "laptop", now - 3 * DAY_MS, {
      last_used_at: new Date(now - 3_600_000).toISOString(),
    }),
    buildRecord(userId, "old ci runner", now - 120 * DAY_MS, {
      expires_at: new Date(now - 30 * DAY_MS).toISOString(),
      last_used_at: new Date(now - 31 * DAY_MS).toISOString(),
    }),
    buildRecord(userId, "lost phone", now - 40 * DAY_MS, {
      revoked_at: new Date(now - 20 * DAY_MS).toISOString(),
    }),
  ];
}

export function seededRecords(variant: TokensVariant, now: number): TokenRecord[] {
  if (variant === "none") {
    return [];
  }
  const build = variant === "full" ? fullRecords : expiredRecords;
  return SEEDED_USER_IDS.flatMap((userId) => build(userId, now));
}
