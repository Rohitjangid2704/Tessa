"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { formatDateTime } from "@/components/date-time";
import { FilterBar, type FilterField } from "@/components/filter-bar";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { invariantCatalogQuery } from "@/features/invariants/queries";
import { RUN_KIND_LABELS } from "@/features/runs/labels";
import { runsListQuery } from "@/features/runs/queries";
import { useHydrated } from "@/lib/use-hydrated";
import { shortId } from "../detail-schemas";
import {
  CLASS_FILTER_OPTIONS,
  invariantFilterOptions,
  SEVERITY_FILTER_OPTIONS,
  STATUS_FILTER_OPTIONS,
} from "../labels";
import { RUN_OPTIONS_LIMIT } from "../queries";
import type { FindingFilterValues } from "../schemas";

type FilterKey = Extract<keyof FindingFilterValues, string>;

const ANY_RUN = "any";

interface RunFilterSelectProps {
  targetId: string;
  value: string | undefined;
  onChange: (runId: string | undefined) => void;
}

function RunFilterSelect({ targetId, value, onChange }: RunFilterSelectProps) {
  const hydrated = useHydrated();
  const triggerId = useId();
  const runs = useInfiniteQuery(runsListQuery({ target_id: targetId }, RUN_OPTIONS_LIMIT));
  const items = hydrated ? (runs.data?.items ?? []) : [];
  const selected = items.find((run) => run.id === value);
  const selectedText =
    value === undefined
      ? "Any run"
      : selected === undefined
        ? `Run ${shortId(value)}`
        : `${RUN_KIND_LABELS[selected.kind]} ${formatDateTime(selected.created_at) ?? ""}`.trim();

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={triggerId}>Run</Label>
      <Select
        value={value ?? ANY_RUN}
        onValueChange={(next) => onChange(next === ANY_RUN ? undefined : next)}
      >
        <SelectTrigger id={triggerId} className="w-56 max-w-full">
          <SelectValue>{selectedText}</SelectValue>
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          <SelectItem value={ANY_RUN}>Any run</SelectItem>
          {value !== undefined && selected === undefined ? (
            <SelectItem value={value}>{`Run ${shortId(value)}`}</SelectItem>
          ) : null}
          {items.map((run) => (
            <SelectItem key={run.id} value={run.id}>
              {`${RUN_KIND_LABELS[run.kind]} ${formatDateTime(run.created_at) ?? ""} (${shortId(run.id)})`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export interface FindingFilterBarProps {
  targetId: string;
  values: FindingFilterValues;
  activeCount: number;
  onChange: (patch: Partial<FindingFilterValues>) => void;
  onReset: () => void;
}

export function FindingFilterBar({
  targetId,
  values,
  activeCount,
  onChange,
  onReset,
}: FindingFilterBarProps) {
  const hydrated = useHydrated();
  const catalog = useQuery(invariantCatalogQuery());
  const invariantOptions = invariantFilterOptions(
    hydrated ? catalog.data : undefined,
    values.invariant_id,
  );

  const fields: readonly FilterField<FilterKey>[] = [
    { type: "text", key: "q", label: "Search", placeholder: "Title, fingerprint or invariant" },
    { type: "multi", key: "severity", label: "Severity", options: SEVERITY_FILTER_OPTIONS },
    { type: "multi", key: "class", label: "Class", options: CLASS_FILTER_OPTIONS },
    { type: "multi", key: "invariant_id", label: "Invariant", options: invariantOptions },
    { type: "multi", key: "status", label: "Columns", options: STATUS_FILTER_OPTIONS },
  ];

  return (
    <FilterBar
      label="Filter findings"
      fields={fields}
      values={values}
      onChange={onChange}
      onReset={onReset}
      activeCount={activeCount}
    >
      <RunFilterSelect
        targetId={targetId}
        value={values.run_id}
        onChange={(runId) => onChange({ run_id: runId })}
      />
    </FilterBar>
  );
}
