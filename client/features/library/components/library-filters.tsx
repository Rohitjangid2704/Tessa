"use client";

import { FilterBar, type FilterField } from "@/components/filter-bar";
import { filterOptions } from "@/features/runs/labels";
import { APP_KIND_LABELS, APP_KINDS } from "@/features/targets/app-kinds";
import { TargetFilterSelect } from "@/features/targets/components/target-filter-select";
import type { LibraryFilterValues } from "../schemas";

type FilterKey = "q" | "app_kind";

const FILTER_FIELDS: readonly FilterField<FilterKey>[] = [
  { type: "text", key: "q", label: "Search", placeholder: "Target, hash or note" },
  {
    type: "multi",
    key: "app_kind",
    label: "App kind",
    options: filterOptions(APP_KINDS, APP_KIND_LABELS),
  },
];

export type LibraryFiltersProps = {
  values: LibraryFilterValues;
  activeCount: number;
  onChange: (patch: Partial<LibraryFilterValues>) => void;
  onReset: () => void;
};

export function LibraryFilters({ values, activeCount, onChange, onReset }: LibraryFiltersProps) {
  return (
    <FilterBar
      label="Filter the bundle library"
      fields={FILTER_FIELDS}
      values={values}
      onChange={onChange}
      onReset={onReset}
      activeCount={activeCount}
    >
      <TargetFilterSelect
        value={values.target_id}
        onChange={(targetId) => onChange({ target_id: targetId })}
      />
    </FilterBar>
  );
}
