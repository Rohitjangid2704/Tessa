import { useQuery } from "@tanstack/react-query";
import { meQuery } from "@/features/system/queries";
import { useHydrated } from "@/lib/use-hydrated";
import { PERMISSIONS, isPermissionId, requirementText, type PermissionId } from "./permissions";
import type { UserRole } from "./schemas";

export const ROLE_RANK = { viewer: 0, member: 1, admin: 2 } as const satisfies Record<
  UserRole,
  number
>;

export type PermissionCheck = {
  allowed: boolean;
  isPending: boolean;
  requiredRole: UserRole;
  reason: string | null;
};

export function roleAtLeast(role: UserRole | null | undefined, minimum: UserRole): boolean {
  return role !== null && role !== undefined && ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export function canDo(role: UserRole | null | undefined, action: PermissionId): boolean {
  return roleAtLeast(role, PERMISSIONS[action]);
}

export function evaluatePermission(
  role: UserRole | null | undefined,
  isPending: boolean,
  action: PermissionId,
): PermissionCheck {
  const requiredRole = PERMISSIONS[action];
  const allowed = !isPending && roleAtLeast(role, requiredRole);
  return {
    allowed,
    isPending,
    requiredRole,
    reason: allowed || isPending ? null : requirementText(requiredRole),
  };
}

export function useCurrentRole(): { role: UserRole | null; isPending: boolean } {
  const hydrated = useHydrated();
  const query = useQuery(meQuery());
  if (!hydrated) {
    return { role: null, isPending: true };
  }
  return { role: query.data?.role ?? null, isPending: query.isPending };
}

export function useCan(minimum: UserRole | PermissionId): boolean {
  const { role } = useCurrentRole();
  return roleAtLeast(role, isPermissionId(minimum) ? PERMISSIONS[minimum] : minimum);
}

export function useCanDo(action: PermissionId): PermissionCheck {
  const { role, isPending } = useCurrentRole();
  return evaluatePermission(role, isPending, action);
}
