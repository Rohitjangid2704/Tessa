"use client";

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
import {
  DEFAULT_PROPOSAL_SORT,
  type ProposalFilterKey,
  type ProposalFilterValues,
} from "../filters";
import {
  PROPOSAL_RISK_LABELS,
  PROPOSAL_RISKS,
  PROPOSAL_SORT_LABELS,
  PROPOSAL_SORTS,
  PROPOSAL_STATUS_LABELS,
  PROPOSAL_STATUSES,
  type ProposalSort,
} from "../labels";

export interface ProposalFiltersProps {
  values: ProposalFilterValues;
  onChange: (patch: Partial<ProposalFilterValues>) => void;
  onReset: () => void;
  activeCount: number;
  areas: readonly string[];
}

export function buildProposalFilterFields(
  areas: readonly string[],
): FilterField<ProposalFilterKey>[] {
  return [
    {
      type: "multi",
      key: "risk",
      label: "Risk",
      options: PROPOSAL_RISKS.map((risk) => ({ value: risk, label: PROPOSAL_RISK_LABELS[risk] })),
    },
    {
      type: "multi",
      key: "status",
      label: "Status",
      options: PROPOSAL_STATUSES.map((status) => ({
        value: status,
        label: PROPOSAL_STATUS_LABELS[status],
      })),
    },
    {
      type: "multi",
      key: "area",
      label: "Area",
      options: areas.map((name) => ({ value: name, label: name })),
    },
  ];
}

function isSort(value: string): value is ProposalSort {
  return PROPOSAL_SORTS.some((sort) => sort === value);
}

export function ProposalFilters({
  values,
  onChange,
  onReset,
  activeCount,
  areas,
}: ProposalFiltersProps) {
  const sortId = useId();
  const sort = values.sort ?? DEFAULT_PROPOSAL_SORT;

  return (
    <FilterBar
      label="Filter proposal items"
      fields={buildProposalFilterFields(areas)}
      values={values}
      onChange={onChange}
      onReset={onReset}
      activeCount={activeCount}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={sortId}>Sort</Label>
        <Select
          value={sort}
          onValueChange={(next) => {
            if (isSort(next)) {
              onChange({ sort: next });
            }
          }}
        >
          <SelectTrigger id={sortId} className="w-56 max-w-full">
            <SelectValue>{PROPOSAL_SORT_LABELS[sort]}</SelectValue>
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            {PROPOSAL_SORTS.map((entry) => (
              <SelectItem key={entry} value={entry}>
                {PROPOSAL_SORT_LABELS[entry]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </FilterBar>
  );
}
