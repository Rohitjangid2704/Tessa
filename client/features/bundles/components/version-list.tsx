"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";
import { DateTime } from "@/components/date-time";
import {
  createDataTableColumnHelper,
  DataTable,
  DataTableFooter,
  type SortingState,
} from "@/components/data-table";
import { EmptyState } from "@/components/states/empty-state";
import { sortingToSortParam } from "@/lib/api/pagination";
import type { components } from "@/lib/api/schema";
import { targetRoutes } from "@/lib/routes";
import { describeSource, shortHash } from "../format";
import { bundleVersionsOptions, DEFAULT_BUNDLE_SORT } from "../queries";
import { CompletenessBadge, ValidationBadge } from "./bundle-badges";

type BundleSummary = components["schemas"]["BundleSummary"];

const DEFAULT_SORTING: SortingState = [{ id: "version", desc: true }];
const COMPRESS_COMMAND = "Compress-Archive -Path tessa -DestinationPath tessa.zip";

const helper = createDataTableColumnHelper<BundleSummary>();

function createVersionColumns(targetId: string) {
  return helper.columns([
    helper.accessor("version", {
      header: "Version",
      sortDescFirst: true,
      cell: (info) => (
        <Link
          href={targetRoutes.bundle(targetId, info.row.original.id)}
          className="font-medium underline underline-offset-4"
        >
          Version {info.getValue()}
        </Link>
      ),
    }),
    helper.display({
      id: "validation",
      header: "Validation",
      enableSorting: false,
      cell: (info) => <ValidationBadge status={info.row.original.validation_status} />,
    }),
    helper.display({
      id: "completeness",
      header: "Completeness",
      enableSorting: false,
      cell: (info) => (
        <span className="flex flex-wrap items-center gap-2">
          <span className="tabular-nums">{info.row.original.completeness_score} of 100</span>
          <CompletenessBadge status={info.row.original.completeness_status} />
        </span>
      ),
    }),
    helper.accessor("feature_count", {
      header: "Features",
      enableSorting: false,
      meta: { align: "end" },
      cell: (info) => <span className="tabular-nums">{info.getValue()}</span>,
    }),
    helper.accessor("source", {
      header: "Source",
      enableSorting: false,
      cell: (info) => describeSource(info.getValue()),
    }),
    helper.accessor("uploaded_at", {
      header: "Uploaded",
      enableSorting: false,
      cell: (info) => <DateTime value={info.getValue()} />,
    }),
    helper.accessor("hash", {
      header: "Hash",
      enableSorting: false,
      cell: (info) => <code className="font-mono text-xs">{shortHash(info.getValue())}</code>,
    }),
  ]);
}

export interface VersionListProps {
  targetId: string;
}

export function VersionList({ targetId }: VersionListProps) {
  const [sorting, setSorting] = useState<SortingState>(DEFAULT_SORTING);
  const sort = sortingToSortParam(sorting) ?? DEFAULT_BUNDLE_SORT;
  const query = useInfiniteQuery(bundleVersionsOptions(targetId, sort));
  const columns = useMemo(() => createVersionColumns(targetId), [targetId]);

  return (
    <DataTable<BundleSummary>
      label="Bundle versions"
      columns={columns}
      data={query.data?.items}
      getRowId={(row) => row.id}
      isLoading={query.isPending}
      isFetching={query.isFetching}
      error={query.error}
      onRetry={() => void query.refetch()}
      manualSorting
      sorting={sorting}
      onSortingChange={setSorting}
      emptyState={
        <EmptyState
          title="No versions yet"
          description="Zip the tessa folder Claude Code wrote, drop the zip above or paste its manifest. Each upload with new content becomes the next version."
          action={
            <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs break-all">
              {COMPRESS_COMMAND}
            </code>
          }
        />
      }
      footer={
        <DataTableFooter
          noun="version"
          loadedCount={query.data?.loadedCount ?? 0}
          total={query.data?.total}
          hasNextPage={query.hasNextPage}
          isFetchingNextPage={query.isFetchingNextPage}
          onLoadMore={() => void query.fetchNextPage()}
        />
      }
    />
  );
}
