"use client";

import type { Ref } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { UserRole } from "@/lib/auth/schemas";
import { cn } from "@/lib/utils";
import { ROLE_LABELS } from "../labels";
import { USER_ROLES } from "../schemas";

export interface RoleSelectProps {
  value: UserRole;
  onValueChange: (role: UserRole) => void;
  label: string;
  id?: string;
  disabled?: boolean;
  invalid?: boolean;
  size?: "sm" | "default";
  className?: string;
  triggerRef?: Ref<HTMLButtonElement>;
  onBlur?: () => void;
}

function isUserRole(value: string): value is UserRole {
  return USER_ROLES.some((role) => role === value);
}

export function RoleSelect({
  value,
  onValueChange,
  label,
  id,
  disabled = false,
  invalid = false,
  size = "default",
  className,
  triggerRef,
  onBlur,
}: RoleSelectProps) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (isUserRole(next)) {
          onValueChange(next);
        }
      }}
    >
      <SelectTrigger
        id={id}
        ref={triggerRef}
        size={size}
        aria-label={label}
        aria-invalid={invalid ? true : undefined}
        data-slot="role-select"
        data-role={value}
        onBlur={onBlur}
        className={cn("w-36", className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        {USER_ROLES.map((role) => (
          <SelectItem key={role} value={role}>
            {ROLE_LABELS[role]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
