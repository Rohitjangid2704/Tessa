"use client";

import { createContext, useContext } from "react";
import type { WidgetProps } from "@/components/schema-form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { CatalogRole } from "@/features/catalog/types";

const NO_ROLES: readonly CatalogRole[] = [];

export const UNSET_ROLE_VALUE = "__no_role__";

export const RoleOptionsContext = createContext<readonly CatalogRole[]>(NO_ROLES);

export function RoleWidget({ spec, id, value, error, disabled, onChange, describedBy }: WidgetProps) {
  const roles = useContext(RoleOptionsContext);

  if (roles.length === 0) {
    return (
      <Input
        id={id}
        name={spec.name}
        value={value}
        disabled={disabled}
        placeholder="guest"
        autoComplete="off"
        aria-invalid={error !== undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  const known = roles.some((role) => role.id === value);
  return (
    <Select
      value={value === "" ? UNSET_ROLE_VALUE : value}
      disabled={disabled}
      onValueChange={(next) => onChange(next === UNSET_ROLE_VALUE ? "" : next)}
    >
      <SelectTrigger
        id={id}
        className="w-full"
        aria-invalid={error !== undefined}
        aria-describedby={describedBy}
      >
        <SelectValue placeholder="Pick when starting a run" />
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        <SelectItem value={UNSET_ROLE_VALUE}>Pick when starting a run</SelectItem>
        {known || value === "" ? null : <SelectItem value={value}>{value}</SelectItem>}
        {roles.map((role) => (
          <SelectItem key={role.id} value={role.id}>
            {role.id}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
