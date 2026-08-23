"use client";

import { useId } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ANY_VALUE = "any";

export interface FilterSelectOption<Value extends string> {
  value: Value;
  label: string;
}

export type FilterSelectProps<Value extends string> = {
  label: string;
  anyLabel: string;
  value: Value | undefined;
  options: readonly FilterSelectOption<Value>[];
  onChange: (value: Value | undefined) => void;
};

export function FilterSelect<Value extends string>({
  label,
  anyLabel,
  value,
  options,
  onChange,
}: FilterSelectProps<Value>) {
  const triggerId = useId();
  const selected = options.find((option) => option.value === value);

  function change(next: string): void {
    onChange(options.find((option) => option.value === next)?.value);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={triggerId}>{label}</Label>
      <Select value={value ?? ANY_VALUE} onValueChange={change}>
        <SelectTrigger id={triggerId} className="w-48 max-w-full">
          <SelectValue>{selected?.label ?? anyLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          <SelectItem value={ANY_VALUE}>{anyLabel}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
