import { useQuery } from "@tanstack/react-query";
import type { User } from "@/lib/api/types";
import { useCanDo } from "@/lib/auth/can";
import { userActionGate, type UserActionGate } from "./gates";
import { GATE_PENDING_REASON } from "./labels";
import { activeAdminsQuery } from "./queries";
import { useCurrentUser } from "./use-current-user";

export function useUserGate(user: User): UserActionGate {
  const { user: me } = useCurrentUser();
  const access = useCanDo("users.manage");
  const activeAdmins = useQuery(activeAdminsQuery());
  const gate = userActionGate(user, {
    currentUserId: me?.id ?? null,
    activeAdminTotal: activeAdmins.data ?? null,
  });
  if (!access.allowed) {
    return { enabled: false, reason: access.reason ?? GATE_PENDING_REASON, isSelf: gate.isSelf };
  }
  return gate;
}
