"use client";

import { FilterBar, type FilterField } from "@/components/filter-bar";
import {
  CONFIDENCE_LABELS,
  CONFIDENCES,
  FEATURE_KIND_LABELS,
  FEATURE_KINDS,
  type CatalogFilterKey,
  type CatalogFilterValues,
} from "../schemas";
import type { CatalogInterface, CatalogRole } from "../types";

export interface CatalogFiltersProps {
  values: CatalogFilterValues;
  onChange: (patch: Partial<CatalogFilterValues>) => void;
  onReset: () => void;
  activeCount: number;
  areas: readonly string[];
  roles: readonly CatalogRole[];
  interfaces: readonly CatalogInterface[];
}

export function buildCatalogFilterFields(
  areas: readonly string[],
  roles: readonly CatalogRole[],
  interfaces: readonly CatalogInterface[],
): FilterField<CatalogFilterKey>[] {
  return [
    { type: "text", key: "q", label: "Search", placeholder: "Feature id, description or area" },
    {
      type: "multi",
      key: "area",
      label: "Area",
      options: areas.map((name) => ({ value: name, label: name })),
    },
    {
      type: "multi",
      key: "kind",
      label: "Kind",
      options: FEATURE_KINDS.map((kind) => ({ value: kind, label: FEATURE_KIND_LABELS[kind] })),
    },
    {
      type: "multi",
      key: "role",
      label: "Role",
      options: roles.map((role) => ({ value: role.id, label: role.id })),
    },
    {
      type: "multi",
      key: "interface_id",
      label: "Interface",
      options: interfaces.map((entry) => ({ value: entry.id, label: entry.id })),
    },
    {
      type: "multi",
      key: "confidence",
      label: "Confidence",
      options: CONFIDENCES.map((level) => ({ value: level, label: CONFIDENCE_LABELS[level] })),
    },
  ];
}

export function CatalogFilters({
  values,
  onChange,
  onReset,
  activeCount,
  areas,
  roles,
  interfaces,
}: CatalogFiltersProps) {
  return (
    <FilterBar
      label="Filter features"
      fields={buildCatalogFilterFields(areas, roles, interfaces)}
      values={values}
      onChange={onChange}
      onReset={onReset}
      activeCount={activeCount}
    />
  );
}
