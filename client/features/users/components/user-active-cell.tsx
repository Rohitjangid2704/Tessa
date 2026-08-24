"use client";

import { CircleCheck, CircleOff } from "lucide-react";
import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import type { User } from "@/lib/api/types";
import { describeUpdateUserFailure } from "../errors";
import { ACTIVE_STATE_LABELS } from "../labels";
import { useUpdateUser } from "../mutations";
import { useUserGate } from "../use-user-gate";
import { ConfirmUserChangeDialog } from "./confirm-user-change-dialog";
import { GatedControl } from "./gated-control";

export function UserActiveCell({ user }: { user: User }) {
  const gate = useUserGate(user);
  const update = useUpdateUser();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const shownActive = update.isPending
    ? (update.variables?.update.is_active ?? user.is_active)
    : user.is_active;
  const StateIcon = shownActive ? CircleCheck : CircleOff;

  function apply(isActive: boolean): void {
    update.mutate({ userId: user.id, update: { is_active: isActive } });
  }

  function choose(isActive: boolean): void {
    if (isActive) {
      apply(true);
      return;
    }
    setConfirmOpen(true);
  }

  return (
    <div data-slot="user-active-cell" className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <GatedControl reason={gate.reason}>
          <Switch
            size="default"
            checked={shownActive}
            onCheckedChange={choose}
            disabled={!gate.enabled || update.isPending}
            aria-label={`Account active for ${user.name}`}
          />
        </GatedControl>
        <span className="inline-flex items-center gap-1 text-sm">
          <StateIcon aria-hidden="true" className="size-3.5" />
          {shownActive ? ACTIVE_STATE_LABELS.active : ACTIVE_STATE_LABELS.inactive}
        </span>
      </div>
      {update.isError ? (
        <p role="alert" className="max-w-56 text-xs text-destructive">
          {describeUpdateUserFailure(update.error)}
        </p>
      ) : null}
      <ConfirmUserChangeDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Deactivate ${user.name}?`}
        description="They are signed out and cannot sign in again until an admin reactivates the account. Their runs, labels and history stay."
        confirmLabel="Deactivate"
        onConfirm={() => apply(false)}
      />
    </div>
  );
}
