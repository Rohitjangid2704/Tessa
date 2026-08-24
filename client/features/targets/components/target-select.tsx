"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { TARGET_TIER_LABELS } from "../app-kinds";
import type { TargetTier } from "../types";

export interface TargetSelectOption {
  id: string;
  name: string;
  tier: TargetTier;
  archived?: boolean;
}

export interface TargetSelectProps {
  value: string | null;
  onChange: (targetId: string) => void;
  options: readonly TargetSelectOption[];
  label: string;
  placeholder?: string;
  triggerLabel?: string;
  className?: string;
  disabled?: boolean;
}

export function describeTargetOption(option: TargetSelectOption): string {
  const marks = [
    option.tier === "production" ? TARGET_TIER_LABELS.production.toLowerCase() : null,
    option.archived ? "archived" : null,
  ].filter((mark) => mark !== null);
  return marks.length === 0 ? option.name : `${option.name} (${marks.join(", ")})`;
}

export function TargetSelect({
  value,
  onChange,
  options,
  label,
  placeholder = "Select a target",
  triggerLabel,
  className,
  disabled = false,
}: TargetSelectProps) {
  const selected = options.find((option) => option.id === value);
  return (
    <Select value={value ?? ""} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger aria-label={label} className={cn("w-56 max-w-full", className)}>
        <SelectValue placeholder={placeholder}>
          {selected ? describeTargetOption(selected) : (triggerLabel ?? placeholder)}
        </SelectValue>
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id}>
            {describeTargetOption(option)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
