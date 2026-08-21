"use client";

import type { ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCanDo, type PermissionCheck } from "@/lib/auth/can";
import type { PermissionId } from "@/lib/auth/permissions";

export type PermissionControlState = PermissionCheck & { disabled: boolean };

export type RequiresPermissionProps = {
  action: PermissionId;
  children: (state: PermissionControlState) => ReactElement;
};

export function RequiresPermission({ action, children }: RequiresPermissionProps) {
  const check = useCanDo(action);
  const control = children({ ...check, disabled: !check.allowed });
  if (check.reason === null) {
    return control;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="inline-flex"
          data-slot="requires-permission"
          data-required-role={check.requiredRole}
        >
          {control}
        </span>
      </TooltipTrigger>
      <TooltipContent>{check.reason}</TooltipContent>
    </Tooltip>
  );
}
