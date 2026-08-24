"use client";

import { useId } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type { CatalogRole } from "@/features/catalog/types";
import { isRoleChecked, toggleRoleId } from "../plan-selection";
import { OptionSection } from "./option-section";

export interface RolePickerProps {
  roles: readonly CatalogRole[];
  value: readonly string[];
  onChange: (roleIds: readonly string[]) => void;
  disabled?: boolean;
}

interface CheckRowProps {
  id: string;
  label: string;
  hint?: string;
  monospace?: boolean;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}

function CheckRow({
  id,
  label,
  hint,
  monospace = false,
  checked,
  disabled,
  onCheckedChange,
}: CheckRowProps) {
  return (
    <div className="flex items-start gap-2">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        className="mt-0.5"
      />
      <Label htmlFor={id} className="flex-col items-start gap-0.5 leading-snug font-normal">
        <span className={monospace ? "font-mono text-xs" : undefined}>{label}</span>
        {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      </Label>
    </div>
  );
}

export function RolePicker({ roles, value, onChange, disabled = false }: RolePickerProps) {
  const groupId = useId();
  const catalogRoleIds = roles.map((role) => role.id);

  return (
    <OptionSection
      title="Roles"
      description="Run features as these roles. A feature only runs as the roles it declares."
    >
      <div className="flex flex-col gap-2">
        <CheckRow
          id={`${groupId}-all`}
          label="All roles"
          hint="Every role a feature declares"
          checked={value.length === 0}
          disabled={disabled}
          onCheckedChange={(checked) => {
            if (checked) {
              onChange([]);
            }
          }}
        />
        {roles.map((role) => (
          <CheckRow
            key={role.id}
            id={`${groupId}-${role.id}`}
            label={role.id}
            monospace
            hint={role.description === "" ? undefined : role.description}
            checked={isRoleChecked(value, role.id)}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onChange(toggleRoleId(value, role.id, checked, catalogRoleIds))
            }
          />
        ))}
      </div>
    </OptionSection>
  );
}
