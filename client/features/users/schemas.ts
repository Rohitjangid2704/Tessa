import { z } from "zod";
import type { UserCreate } from "@/lib/api/types";
import { userRoleSchema, type UserRole } from "@/lib/auth/schemas";
import { createSearchParamsCodec, enumListParam, textParam } from "@/lib/search-params";

export const USER_ROLES = ["viewer", "member", "admin"] as const satisfies readonly UserRole[];

export const ACTIVE_FILTER_VALUES = ["true", "false"] as const;

export type ActiveFilterValue = (typeof ACTIVE_FILTER_VALUES)[number];

export const USER_NAME_MAX_LENGTH = 120;
export const USER_EMAIL_MAX_LENGTH = 320;
export const USER_PASSWORD_MIN_LENGTH = 12;
export const USER_PASSWORD_MAX_LENGTH = 1024;
export const USER_SEARCH_MAX_LENGTH = 200;

export const DEFAULT_NEW_USER_ROLE: UserRole = "viewer";

const ROLE_ORDER: Record<UserRole, number> = { viewer: 0, member: 1, admin: 2 };

export const userFiltersCodec = createSearchParamsCodec({
  q: textParam(USER_SEARCH_MAX_LENGTH),
  role: enumListParam(USER_ROLES),
  is_active: enumListParam(ACTIVE_FILTER_VALUES),
});

export type UserFilterValues = ReturnType<typeof userFiltersCodec.parse>;

export const userCreateSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Enter an email address")
    .max(USER_EMAIL_MAX_LENGTH, `Use at most ${USER_EMAIL_MAX_LENGTH} characters`)
    .pipe(z.email({ error: "Enter a valid email address" })),
  name: z
    .string()
    .trim()
    .min(1, "Enter a name")
    .max(USER_NAME_MAX_LENGTH, `Use at most ${USER_NAME_MAX_LENGTH} characters`),
  role: userRoleSchema,
  password: z
    .string()
    .max(USER_PASSWORD_MAX_LENGTH, `Use at most ${USER_PASSWORD_MAX_LENGTH} characters`)
    .refine(
      (value) => value === "" || value.length >= USER_PASSWORD_MIN_LENGTH,
      `Use at least ${USER_PASSWORD_MIN_LENGTH} characters, or leave it empty for SSO-only sign-in`,
    ),
});

export type UserCreateInput = z.infer<typeof userCreateSchema>;

export function toUserCreate(input: UserCreateInput): UserCreate {
  const base: UserCreate = { email: input.email, name: input.name, role: input.role };
  return input.password === "" ? base : { ...base, password: input.password };
}

export function activeFilterOf(
  selected: readonly ActiveFilterValue[] | undefined,
): boolean | undefined {
  if (selected === undefined || selected.length !== 1) {
    return undefined;
  }
  return selected[0] === "true";
}

export function isRoleLowered(from: UserRole, to: UserRole): boolean {
  return ROLE_ORDER[to] < ROLE_ORDER[from];
}
