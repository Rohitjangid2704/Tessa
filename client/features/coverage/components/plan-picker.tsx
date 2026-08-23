"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useId } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { savedPlansQuery } from "@/features/plans/queries";
import { BASELINE_PLAN_LABEL, BASELINE_PLAN_VALUE } from "../labels";

export interface PlanPickerProps {
  targetId: string;
  value: string | null;
  onChange: (planId: string | null) => void;
}

const UNNAMED_PLAN = "Untitled plan";

export function PlanPicker({ targetId, value, onChange }: PlanPickerProps) {
  const triggerId = useId();
  const saved = useInfiniteQuery(savedPlansQuery(targetId));
  const plans = saved.data?.items ?? [];
  const selectedPlan = plans.find((plan) => plan.id === value);
  const selectedLabel =
    value === null ? BASELINE_PLAN_LABEL : (selectedPlan?.name ?? UNNAMED_PLAN);

  return (
    <div className="flex flex-col gap-1.5" data-slot="coverage-plan-picker">
      <Label htmlFor={triggerId}>Plan</Label>
      <Select
        value={value ?? BASELINE_PLAN_VALUE}
        onValueChange={(next) => onChange(next === BASELINE_PLAN_VALUE ? null : next)}
      >
        <SelectTrigger id={triggerId} className="w-64 max-w-full">
          <SelectValue>{selectedLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          <SelectItem value={BASELINE_PLAN_VALUE}>{BASELINE_PLAN_LABEL}</SelectItem>
          {value !== null && selectedPlan === undefined ? (
            <SelectItem value={value}>{UNNAMED_PLAN}</SelectItem>
          ) : null}
          {plans.map((plan) => (
            <SelectItem key={plan.id} value={plan.id}>
              {plan.name ?? UNNAMED_PLAN}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
