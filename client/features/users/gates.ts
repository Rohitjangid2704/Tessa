import type { User } from "@/lib/api/types";
import { GATE_PENDING_REASON, LAST_ADMIN_REASON, SELF_ACTION_REASON } from "./labels";

export interface UserGateContext {
  currentUserId: string | null;
  activeAdminTotal: number | null;
}

export interface UserActionGate {
  enabled: boolean;
  reason: string | null;
  isSelf: boolean;
}

export function userActionGate(user: User, context: UserGateContext): UserActionGate {
  const isSelf = context.currentUserId !== null && user.id === context.currentUserId;
  if (context.currentUserId === null) {
    return { enabled: false, reason: GATE_PENDING_REASON, isSelf };
  }
  if (isSelf) {
    return { enabled: false, reason: SELF_ACTION_REASON, isSelf };
  }
  const isActiveAdmin = user.role === "admin" && user.is_active;
  if (isActiveAdmin && context.activeAdminTotal === null) {
    return { enabled: false, reason: GATE_PENDING_REASON, isSelf };
  }
  if (isActiveAdmin && context.activeAdminTotal !== null && context.activeAdminTotal <= 1) {
    return { enabled: false, reason: LAST_ADMIN_REASON, isSelf };
  }
  return { enabled: true, reason: null, isSelf };
}
