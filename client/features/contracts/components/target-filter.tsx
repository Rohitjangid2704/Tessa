"use client";

import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { describeTargetOption } from "@/features/targets/components/target-select";
import { targetOptionsQuery } from "@/features/targets/queries";
import { useHydrated } from "@/lib/use-hydrated";

const ANY_TARGET = "any";

export type TargetFilterProps = {
  label: string;
  value: string | undefined;
  onChange: (targetId: string | undefined) => void;
};

export function TargetFilter({ label, value, onChange }: TargetFilterProps) {
  const hydrated = useHydrated();
  const triggerId = useId();
  const options = useQuery(targetOptionsQuery());
  const targets = hydrated ? (options.data ?? []) : [];
  const selected = targets.find((target) => target.id === value);
  const shown =
    value === undefined
      ? "Any target"
      : selected === undefined
        ? "Selected target"
        : describeTargetOption({ id: selected.id, name: selected.name, tier: selected.tier });

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={triggerId}>{label}</Label>
      <Select
        value={value ?? ANY_TARGET}
        onValueChange={(next) => onChange(next === ANY_TARGET ? undefined : next)}
      >
        <SelectTrigger id={triggerId} className="w-56 max-w-full">
          <SelectValue>{shown}</SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          <SelectItem value={ANY_TARGET}>Any target</SelectItem>
          {targets.map((target) => (
            <SelectItem key={target.id} value={target.id}>
              {describeTargetOption({ id: target.id, name: target.name, tier: target.tier })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
