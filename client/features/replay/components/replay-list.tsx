"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { createDataTableColumnHelper, DataTable, DataTableFooter } from "@/components/data-table";
import { DateTime } from "@/components/date-time";
import { EmptyState } from "@/components/states/empty-state";
import { RunStatusBadge } from "@/components/status/run-status-badge";
import type { Replay } from "@/lib/api/types";
import { replayRoutes, runRoutes } from "@/lib/routes";
import { useHydrated } from "@/lib/use-hydrated";
import { replaysListQuery } from "../queries";

const helper = createDataTableColumnHelper<Replay>();

const REPLAY_COLUMNS = helper.columns([
  helper.display({
    id: "source",
    header: "Export",
    enableSorting: false,
    cell: (info) => {
      const replay = info.row.original;
      return (
        <Link
          href={replayRoutes.detail(replay.id)}
          className="font-medium break-all underline-offset-4 hover:underline"
        >
          {replay.source_name}
        </Link>
      );
    },
  }),
  helper.display({
    id: "status",
    header: "Status",
    enableSorting: false,
    cell: (info) => <RunStatusBadge status={info.row.original.status} />,
  }),
  helper.display({
    id: "records",
    header: "Records",
    enableSorting: false,
    meta: { align: "end" },
    cell: (info) => <span className="tabular-nums">{info.row.original.records_total}</span>,
  }),
  helper.display({
    id: "created",
    header: "Cases created",
    enableSorting: false,
    meta: { align: "end" },
    cell: (info) => <span className="tabular-nums">{info.row.original.cases_created}</span>,
  }),
  helper.display({
    id: "rejected",
    header: "Rejected",
    enableSorting: false,
    meta: { align: "end" },
    cell: (info) => <span className="tabular-nums">{info.row.original.cases_rejected}</span>,
  }),
  helper.display({
    id: "uploaded",
    header: "Uploaded",
    enableSorting: false,
    cell: (info) => <DateTime value={info.row.original.created_at} />,
  }),
  helper.display({
    id: "run",
    header: "Run",
    enableSorting: false,
    cell: (info) => (
      <Link
        href={runRoutes.detail(info.row.original.run_id)}
        className="text-sm underline underline-offset-4"
      >
        Open the run
      </Link>
    ),
  }),
]);

export type ReplayListProps = {
  targetId: string;
  selectedId: string | undefined;
};

export function ReplayList({ targetId, selectedId }: ReplayListProps) {
  const headingId = useId();
  const hydrated = useHydrated();
  const query = useInfiniteQuery(replaysListQuery());
  const rows = hydrated
    ? query.data?.items.filter((replay) => replay.target_id === targetId)
    : undefined;

  return (
    <section aria-labelledby={headingId} data-slot="replay-list" className="flex flex-col gap-3">
      <h2 id={headingId} className="text-base font-semibold">
        Uploaded exports
      </h2>
      <DataTable<Replay>
        label="Replays"
        columns={REPLAY_COLUMNS}
        data={rows}
        getRowId={(row) => row.id}
        isLoading={!hydrated || query.isPending}
        isFetching={hydrated && query.isFetching}
        error={hydrated ? query.error : null}
        onRetry={() => void query.refetch()}
        emptyState={
          <EmptyState
            icon={History}
            title="No replays yet"
            description="Upload a production export above. Each record becomes a candidate case for the review queue, or a rejected record with its reason."
          />
        }
        getRowProps={(row) => ({
          "data-replay-id": row.id,
          "data-status": row.status,
          "data-selected": row.id === selectedId,
        })}
        footer={
          <DataTableFooter
            noun="replay"
            loadedCount={rows?.length ?? 0}
            hasNextPage={hydrated && query.hasNextPage}
            isFetchingNextPage={query.isFetchingNextPage}
            onLoadMore={() => void query.fetchNextPage()}
          />
        }
      />
    </section>
  );
}
