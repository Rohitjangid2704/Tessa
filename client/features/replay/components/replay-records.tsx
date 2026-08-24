"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { ListChecks, SearchX } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { createDataTableColumnHelper, DataTable, DataTableFooter } from "@/components/data-table";
import { FilterBar, type FilterField } from "@/components/filter-bar";
import { EmptyState } from "@/components/states/empty-state";
import { Button } from "@/components/ui/button";
import { filterOptions } from "@/features/runs/labels";
import type { ReplayRecord } from "@/lib/api/types";
import { scenarioRoutes } from "@/lib/routes";
import { useUrlFilters } from "@/lib/url-state";
import { useHydrated } from "@/lib/use-hydrated";
import {
  REPLAY_REASON_EXPLANATIONS,
  REPLAY_REASON_LABELS,
  REPLAY_RECORD_STATUS_LABELS,
  UNKNOWN_REASON_LABEL,
} from "../labels";
import { replayRecordsQuery, type ReplayRecordFilters } from "../queries";
import {
  REPLAY_REASON_CODES,
  REPLAY_RECORD_STATUSES,
  replayRecordFiltersCodec,
  type ReplayRecordFilterValues,
} from "../schemas";
import { ReplayRecordBadge } from "./replay-record-badge";

const FILTER_FIELDS: readonly FilterField<keyof ReplayRecordFilterValues & string>[] = [
  {
    type: "multi",
    key: "status",
    label: "Status",
    options: filterOptions(REPLAY_RECORD_STATUSES, REPLAY_RECORD_STATUS_LABELS),
  },
  {
    type: "multi",
    key: "reason_code",
    label: "Reason",
    options: filterOptions(REPLAY_REASON_CODES, REPLAY_REASON_LABELS),
  },
];

const helper = createDataTableColumnHelper<ReplayRecord>();

function ReasonCell({ record }: { record: ReplayRecord }) {
  if (record.status !== "rejected") {
    return <span className="text-muted-foreground">Not applicable</span>;
  }
  if (record.reason_code === null) {
    return (
      <span data-slot="unexplained-reason" className="text-sm font-medium text-destructive">
        {UNKNOWN_REASON_LABEL}
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-sm font-medium">
        {REPLAY_REASON_LABELS[record.reason_code]}{" "}
        <code className="font-mono text-xs text-muted-foreground">{record.reason_code}</code>
      </span>
      <span className="text-xs text-muted-foreground">
        {record.reason ?? REPLAY_REASON_EXPLANATIONS[record.reason_code]}
      </span>
    </span>
  );
}

const RECORD_COLUMNS = helper.columns([
  helper.display({
    id: "index",
    header: "Record",
    enableSorting: false,
    meta: { align: "end" },
    cell: (info) => <span className="tabular-nums">{info.row.original.index + 1}</span>,
  }),
  helper.display({
    id: "status",
    header: "Outcome",
    enableSorting: false,
    cell: (info) => <ReplayRecordBadge status={info.row.original.status} />,
  }),
  helper.display({
    id: "reason",
    header: "Reason",
    enableSorting: false,
    cell: (info) => <ReasonCell record={info.row.original} />,
  }),
  helper.display({
    id: "excerpt",
    header: "Redacted excerpt",
    enableSorting: false,
    cell: (info) => (
      <span data-slot="record-excerpt" className="line-clamp-3 text-sm wrap-break-word">
        {info.row.original.excerpt === "" ? "(no excerpt)" : info.row.original.excerpt}
      </span>
    ),
  }),
  helper.display({
    id: "case",
    header: "Case",
    enableSorting: false,
    cell: (info) => {
      const { scenario_id: scenarioId } = info.row.original;
      return scenarioId === null ? (
        <span className="text-muted-foreground">None</span>
      ) : (
        <Link
          href={scenarioRoutes.detail(scenarioId)}
          className="text-sm underline underline-offset-4"
        >
          Open the case
        </Link>
      );
    },
  }),
]);

export type ReplayRecordsProps = {
  replayId: string;
  casesRejected: number;
  active: boolean;
};

function toQueryFilters(values: ReplayRecordFilterValues): ReplayRecordFilters {
  return {
    ...(values.status === undefined ? {} : { status: values.status }),
    ...(values.reason_code === undefined ? {} : { reason_code: values.reason_code }),
  };
}

const POLL_MS = 2000;

export function ReplayRecords({ replayId, casesRejected, active }: ReplayRecordsProps) {
  const headingId = useId();
  const hydrated = useHydrated();
  const { values, setFilters, resetFilters, activeCount } = useUrlFilters(replayRecordFiltersCodec);
  const query = useInfiniteQuery(
    replayRecordsQuery(replayId, toQueryFilters(values), active ? POLL_MS : false),
  );
  const loaded = hydrated ? query.data?.items : undefined;
  const unexplained = (loaded ?? []).filter(
    (record) => record.status === "rejected" && record.reason_code === null,
  ).length;

  return (
    <section aria-labelledby={headingId} data-slot="replay-records" className="flex flex-col gap-3">
      <h2 id={headingId} className="text-base font-semibold">
        Every record
      </h2>
      <p className="text-sm text-muted-foreground">
        Each record of the export ends as a case for review or as a rejected record with its
        reason, so the {casesRejected} rejected {casesRejected === 1 ? "record is" : "records are"}{" "}
        never unexplained. Excerpts are redacted and shown as plain text.
      </p>
      {unexplained > 0 ? (
        <p role="alert" data-slot="unexplained-warning" className="text-sm text-destructive">
          {unexplained} rejected {unexplained === 1 ? "record has" : "records have"} no reason code
          from the server. This should not happen; report it with the request ID of this page.
        </p>
      ) : null}
      <FilterBar
        label="Filter the records"
        fields={FILTER_FIELDS}
        values={values}
        onChange={(patch) => setFilters(patch, { history: "replace" })}
        onReset={() => resetFilters({ history: "replace" })}
        activeCount={activeCount}
      />
      <DataTable<ReplayRecord>
        label="Replay records"
        columns={RECORD_COLUMNS}
        data={loaded}
        getRowId={(row) => row.id}
        isLoading={!hydrated || query.isPending}
        isFetching={hydrated && query.isFetching && !query.isFetchingNextPage}
        error={hydrated ? query.error : null}
        onRetry={() => void query.refetch()}
        emptyState={
          activeCount > 0 ? (
            <EmptyState
              icon={SearchX}
              title="No records match these filters"
              description="Clear the filters to see every record of this export."
              action={
                <Button type="button" variant="outline" onClick={() => resetFilters({ history: "replace" })}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={ListChecks}
              title="No records yet"
              description={
                active
                  ? "Records appear here as the server reads the export."
                  : "The server did not read any record from this export."
              }
            />
          )
        }
        getRowProps={(row) => ({
          "data-record-index": row.index,
          "data-status": row.status,
          "data-reason-code": row.reason_code ?? "",
        })}
        footer={
          <DataTableFooter
            noun="record"
            loadedCount={loaded?.length ?? 0}
            total={hydrated ? query.data?.total : undefined}
            hasNextPage={hydrated && query.hasNextPage}
            isFetchingNextPage={query.isFetchingNextPage}
            onLoadMore={() => void query.fetchNextPage()}
          />
        }
      />
    </section>
  );
}
