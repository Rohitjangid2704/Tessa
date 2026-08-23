"use client";

import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { FilterBar, type FilterField } from "@/components/filter-bar";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { targetOptionsQuery } from "@/features/targets/queries";
import {
  LABEL_REASON_LABELS,
  LABEL_REASONS,
  LABEL_SUBJECT_LABELS,
  LABEL_SUBJECT_TYPES,
  type QueueFilters,
} from "../schemas";

export const ALL_TARGETS_VALUE = "all";

export const QUEUE_FILTER_FIELDS: FilterField<keyof QueueFilters & string>[] = [
  {
    type: "multi",
    key: "subject_type",
    label: "Subject",
    options: LABEL_SUBJECT_TYPES.map((type) => ({
      value: type,
      label: LABEL_SUBJECT_LABELS[type],
    })),
  },
  {
    type: "multi",
    key: "reason",
    label: "Reason",
    options: LABEL_REASONS.map((reason) => ({ value: reason, label: LABEL_REASON_LABELS[reason] })),
  },
];

export interface QueueFiltersProps {
  values: QueueFilters;
  onChange: (patch: Partial<QueueFilters>) => void;
  onReset: () => void;
  activeCount: number;
}

function TargetFilter({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (targetId: string | undefined) => void;
}) {
  const triggerId = useId();
  const targets = useQuery(targetOptionsQuery());
  const options = targets.data ?? [];
  const known = value === undefined || options.some((option) => option.id === value);
  return (
    <div className="flex min-w-48 flex-col gap-1.5">
      <Label htmlFor={triggerId}>Target</Label>
      <Select
        value={value ?? ALL_TARGETS_VALUE}
        onValueChange={(next) => onChange(next === ALL_TARGETS_VALUE ? undefined : next)}
      >
        <SelectTrigger id={triggerId} className="w-56 max-w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          <SelectItem value={ALL_TARGETS_VALUE}>All targets</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.name}
            </SelectItem>
          ))}
          {known || value === undefined ? null : <SelectItem value={value}>{value}</SelectItem>}
        </SelectContent>
      </Select>
    </div>
  );
}

export function QueueFiltersBar({ values, onChange, onReset, activeCount }: QueueFiltersProps) {
  return (
    <FilterBar
      label="Filter the review queue"
      fields={QUEUE_FILTER_FIELDS}
      values={values}
      onChange={onChange}
      onReset={onReset}
      activeCount={activeCount}
    >
      <TargetFilter
        value={values.target_id}
        onChange={(targetId) => onChange({ target_id: targetId })}
      />
    </FilterBar>
  );
}
