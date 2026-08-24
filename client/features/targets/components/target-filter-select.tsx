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
import { useHydrated } from "@/lib/use-hydrated";
import { targetOptionsQuery } from "../queries";
import { describeTargetOption } from "./target-select";

const ALL_TARGETS = "all";

export type TargetFilterSelectProps = {
  value: string | undefined;
  onChange: (targetId: string | undefined) => void;
};

export function TargetFilterSelect({ value, onChange }: TargetFilterSelectProps) {
  const hydrated = useHydrated();
  const triggerId = useId();
  const options = useQuery(targetOptionsQuery());
  const targets = hydrated ? (options.data ?? []) : [];
  const selected = targets.find((target) => target.id === value);
  const triggerText = value === undefined ? "All targets" : (selected?.name ?? "Selected target");

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={triggerId}>Target</Label>
      <Select
        value={value ?? ALL_TARGETS}
        onValueChange={(next) => onChange(next === ALL_TARGETS ? undefined : next)}
      >
        <SelectTrigger id={triggerId} className="w-56 max-w-full">
          <SelectValue>
            {selected === undefined
              ? triggerText
              : describeTargetOption({
                  id: selected.id,
                  name: selected.name,
                  tier: selected.tier,
                })}
          </SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          <SelectItem value={ALL_TARGETS}>All targets</SelectItem>
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
