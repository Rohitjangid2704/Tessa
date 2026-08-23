"use client";

import { useQuery } from "@tanstack/react-query";
import { Scale } from "lucide-react";
import Link from "next/link";
import { createDataTableColumnHelper, DataTable } from "@/components/data-table";
import { DateTime } from "@/components/date-time";
import { EmptyState } from "@/components/states/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatPercent } from "@/features/runs/results-format";
import { TargetFilterSelect } from "@/features/targets/components/target-filter-select";
import type { CalibrationItem, CalibrationKind } from "@/lib/api/types";
import { labelRoutes } from "@/lib/routes";
import { useUrlFilters } from "@/lib/url-state";
import { useHydrated } from "@/lib/use-hydrated";
import { calibrationReportQuery } from "../calibration-queries";
import { queueFiltersCodec } from "../schemas";

const KAPPA_DECIMALS = 2;

const KIND_LABELS = {
  probe: "Probe",
  judge: "Judge",
} as const satisfies Record<CalibrationKind, string>;

export function formatKappaCell(kappa: number | null): string {
  return kappa === null ? "Not enough labels" : kappa.toFixed(KAPPA_DECIMALS);
}

const helper = createDataTableColumnHelper<CalibrationItem>();

const CALIBRATION_COLUMNS = helper.columns([
  helper.accessor("subject", {
    header: "Subject",
    enableSorting: false,
    cell: (info) => <span className="font-mono text-xs wrap-anywhere">{info.getValue()}</span>,
  }),
  helper.accessor("kind", {
    header: "Kind",
    enableSorting: false,
    cell: (info) => <Badge variant="outline">{KIND_LABELS[info.getValue()]}</Badge>,
  }),
  helper.accessor("n_labels", {
    header: "Labels",
    enableSorting: false,
    meta: { align: "end" },
    cell: (info) => (
      <span className="tabular-nums">{info.getValue().toLocaleString("en-US")}</span>
    ),
  }),
  helper.accessor("kappa", {
    header: "Kappa",
    enableSorting: false,
    meta: { align: "end" },
    cell: (info) => {
      const kappa = info.getValue();
      return kappa === null ? (
        <span data-slot="kappa-null" className="text-muted-foreground">
          {formatKappaCell(kappa)}
        </span>
      ) : (
        <span className="font-medium tabular-nums">{formatKappaCell(kappa)}</span>
      );
    },
  }),
  helper.accessor("agreement", {
    header: "Agreement",
    enableSorting: false,
    meta: { align: "end" },
    cell: (info) => <span className="tabular-nums">{formatPercent(info.getValue())}</span>,
  }),
]);

export function CalibrationTable() {
  const hydrated = useHydrated();
  const { values, setFilters } = useUrlFilters(queueFiltersCodec);
  const targetId = values.target_id ?? null;
  const query = useQuery(calibrationReportQuery(targetId));

  return (
    <div data-slot="calibration" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <TargetFilterSelect
          value={values.target_id}
          onChange={(nextTargetId) => setFilters({ target_id: nextTargetId })}
        />
        {query.data === undefined ? null : (
          <p className="text-sm text-muted-foreground">
            Calculated <DateTime value={query.data.generated_at} />
          </p>
        )}
      </div>
      <p className="max-w-3xl text-sm text-muted-foreground">
        Kappa compares the grades of each judge and probe with the labels people gave, after
        removing the agreement chance alone would produce. A subject stays at Not enough labels
        until it has enough decided human labels. Always read it together with the label count.
      </p>
      <DataTable<CalibrationItem>
        label="Calibration"
        columns={CALIBRATION_COLUMNS}
        data={hydrated ? query.data?.items : undefined}
        getRowId={(row) => `${row.kind}:${row.subject}`}
        isLoading={!hydrated || query.isPending}
        isFetching={hydrated && query.isFetching}
        error={hydrated ? query.error : null}
        onRetry={() => void query.refetch()}
        getRowProps={(row) => ({ "data-subject": row.subject, "data-kind": row.kind })}
        emptyState={
          <EmptyState
            title="Nothing to calibrate yet"
            description="Judges and probes appear here once they have graded steps. Your labels then decide how far to trust them."
            icon={Scale}
            action={
              <Button asChild variant="outline">
                <Link href={labelRoutes.queue({ target_id: targetId })}>Open the review queue</Link>
              </Button>
            }
          />
        }
      />
    </div>
  );
}
