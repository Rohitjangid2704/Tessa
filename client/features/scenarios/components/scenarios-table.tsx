"use client";

import { CircleX, TriangleAlert } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { createDataTableColumnHelper, DataTable, type SortingState } from "@/components/data-table";
import { DateTime } from "@/components/date-time";
import { StatusBadge } from "@/components/status/status-badge";
import { Badge } from "@/components/ui/badge";
import { pluralize } from "@/features/bundles/format";
import type { ScenarioSummary } from "@/lib/api/types";
import { scenarioRoutes } from "@/lib/routes";
import { SCENARIO_ORIGIN_LABELS } from "../labels";
import { ScenarioStatusBadge } from "./scenario-status-badge";

const helper = createDataTableColumnHelper<ScenarioSummary>();

function ValidationSummary({ validation }: { validation: ScenarioSummary["validation"] }) {
  if (validation.errors.length > 0) {
    return (
      <StatusBadge
        tone="verdict-fail"
        label={pluralize(validation.errors.length, "error")}
        icon={CircleX}
      />
    );
  }
  if (validation.warnings.length > 0) {
    return (
      <StatusBadge
        tone="verdict-flaky"
        label={pluralize(validation.warnings.length, "warning")}
        icon={TriangleAlert}
      />
    );
  }
  return (
    <span className="text-muted-foreground">{validation.valid ? "Valid" : "Not validated"}</span>
  );
}

const SCENARIO_COLUMNS = helper.columns([
  helper.accessor("title", {
    header: "Title",
    cell: (info) => (
      <span className="flex flex-wrap items-center gap-2">
        <Link
          href={scenarioRoutes.detail(info.row.original.id)}
          className="font-medium underline-offset-4 hover:underline"
        >
          {info.getValue()}
        </Link>
        {info.row.original.synthetic ? <Badge variant="outline">Synthetic</Badge> : null}
      </span>
    ),
  }),
  helper.accessor("status", {
    header: "Status",
    enableSorting: false,
    cell: (info) => <ScenarioStatusBadge status={info.getValue()} />,
  }),
  helper.accessor("origin", {
    header: "Origin",
    enableSorting: false,
    cell: (info) => SCENARIO_ORIGIN_LABELS[info.getValue()],
  }),
  helper.accessor("family", {
    header: "Family",
    enableSorting: false,
    cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
  }),
  helper.accessor("feature_id", {
    header: "Feature",
    enableSorting: false,
    cell: (info) => {
      const featureId = info.getValue();
      return featureId === null ? (
        <span className="text-muted-foreground">None</span>
      ) : (
        <span className="font-mono text-xs">{featureId}</span>
      );
    },
  }),
  helper.display({
    id: "validation",
    header: "Checks",
    enableSorting: false,
    cell: (info) => <ValidationSummary validation={info.row.original.validation} />,
  }),
  helper.accessor("updated_at", {
    header: "Updated",
    sortDescFirst: true,
    cell: (info) => <DateTime value={info.getValue()} />,
  }),
  helper.accessor("created_at", {
    header: "Created",
    sortDescFirst: true,
    cell: (info) => <DateTime value={info.getValue()} />,
  }),
]);

export type ScenariosTableProps = {
  rows: readonly ScenarioSummary[] | undefined;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  onRetry: () => void;
  sorting: SortingState;
  onSortingChange: (sorting: SortingState) => void;
  emptyState: ReactNode;
  footer: ReactNode;
};

export function ScenariosTable({
  rows,
  isLoading,
  isFetching,
  error,
  onRetry,
  sorting,
  onSortingChange,
  emptyState,
  footer,
}: ScenariosTableProps) {
  return (
    <DataTable<ScenarioSummary>
      label="Scenarios"
      columns={SCENARIO_COLUMNS}
      data={rows}
      getRowId={(row) => row.id}
      isLoading={isLoading}
      isFetching={isFetching}
      error={error}
      onRetry={onRetry}
      manualSorting
      sorting={sorting}
      onSortingChange={onSortingChange}
      emptyState={emptyState}
      footer={footer}
      getRowProps={(row) => ({ "data-scenario-id": row.id, "data-status": row.status })}
    />
  );
}
