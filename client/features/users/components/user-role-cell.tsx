"use client";

import { useState } from "react";
import type { User } from "@/lib/api/types";
import type { UserRole } from "@/lib/auth/schemas";
import { describeUpdateUserFailure } from "../errors";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "../labels";
import { useUpdateUser } from "../mutations";
import { isRoleLowered } from "../schemas";
import { useUserGate } from "../use-user-gate";
import { ConfirmUserChangeDialog } from "./confirm-user-change-dialog";
import { GatedControl } from "./gated-control";
import { RoleSelect } from "./role-select";

export function UserRoleCell({ user }: { user: User }) {
  const gate = useUserGate(user);
  const update = useUpdateUser();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmRole, setConfirmRole] = useState<UserRole>(user.role);
  const shownRole: UserRole = update.isPending
    ? (update.variables?.update.role ?? user.role)
    : user.role;

  function apply(role: UserRole): void {
    update.mutate({ userId: user.id, update: { role } });
  }

  function choose(role: UserRole): void {
    if (role === user.role) {
      return;
    }
    if (isRoleLowered(user.role, role)) {
      setConfirmRole(role);
      setConfirmOpen(true);
      return;
    }
    apply(role);
  }

  return (
    <div data-slot="user-role-cell" className="flex flex-col gap-1">
      <GatedControl reason={gate.reason}>
        <RoleSelect
          value={shownRole}
          onValueChange={choose}
          label={`Role for ${user.name}`}
          size="sm"
          disabled={!gate.enabled || update.isPending}
        />
      </GatedControl>
      {update.isError ? (
        <p role="alert" className="max-w-56 text-xs text-destructive">
          {describeUpdateUserFailure(update.error)}
        </p>
      ) : null}
      <ConfirmUserChangeDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Change ${user.name} from ${ROLE_LABELS[user.role]} to ${ROLE_LABELS[confirmRole]}?`}
        description={`${ROLE_LABELS[confirmRole]}: ${ROLE_DESCRIPTIONS[confirmRole]} The change applies immediately and removes access they have today.`}
        confirmLabel={`Change to ${ROLE_LABELS[confirmRole]}`}
        onConfirm={() => apply(confirmRole)}
      />
    </div>
  );
}
