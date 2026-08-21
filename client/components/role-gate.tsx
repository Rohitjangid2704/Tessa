"use client";

import type { ReactNode } from "react";
import { roleAtLeast, useCurrentRole } from "@/lib/auth/can";
import { requiredRoleFor, type PermissionId } from "@/lib/auth/permissions";
import type { UserRole } from "@/lib/auth/schemas";

export type RoleGateRequirement =
  | { min: UserRole; action?: never }
  | { action: PermissionId; min?: never };

export type RoleGateProps = RoleGateRequirement & {
  children: ReactNode;
  fallback?: ReactNode;
  pending?: ReactNode;
};

function minimumRole(requirement: RoleGateRequirement): UserRole {
  return requirement.action === undefined ? requirement.min : requiredRoleFor(requirement.action);
}

export function RoleGate({
  children,
  fallback = null,
  pending = null,
  ...requirement
}: RoleGateProps) {
  const { role, isPending } = useCurrentRole();
  if (isPending) {
    return pending;
  }
  return roleAtLeast(role, minimumRole(requirement)) ? children : fallback;
}
