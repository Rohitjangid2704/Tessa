"use client";

import { createContext, useContext } from "react";
import { createDataTableColumnHelper, DataTable, DataTableFooter } from "@/components/data-table";
import { DateTime } from "@/components/date-time";
import { Button } from "@/components/ui/button";
import { abbreviateHash, HASH_SOURCE_LABELS, NOT_RECORDED_YET, seedHashState } from "../hash-state";
import type { Seed } from "../types";
import { HashStateBadge } from "./hash-compare";
import { ResultStatusBadge } from "./result-status-badge";

interface SeedSelection {
  selectedId: string | null;
  onSelect: (seedId: string) => void;
}

const SeedSelectionContext = createContext<SeedSelection>({
  selectedId: null,
  onSelect: () => undefined,
});

function VersionButton({ seed }: { seed: Seed }) {
  const { selectedId, onSelect } = useContext(SeedSelectionContext);
  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      className="h-auto p-0 font-medium"
      aria-current={seed.id === selectedId ? "true" : undefined}
      aria-label={`Open seed version ${seed.version}`}
      onClick={() => onSelect(seed.id)}
    >
      Version {seed.version}
    </Button>
  );
}

const helper = createDataTableColumnHelper<Seed>();

const columns = helper.columns([
  helper.accessor("version", {
    header: "Version",
    enableSorting: false,
    cell: (info) => <VersionButton seed={info.row.original} />,
  }),
  helper.display({
    id: "state",
    header: "Hash",
    enableSorting: false,
    cell: (info) => <HashStateBadge state={seedHashState(info.row.original)} />,
  }),
  helper.display({
    id: "declared",
    header: "Declared hash",
    enableSorting: false,
    cell: (info) => {
      const seed = info.row.original;
      return seed.declared_hash === null ? (
        <span className="text-muted-foreground italic">{NOT_RECORDED_YET}</span>
      ) : (
        <code title={seed.declared_hash} className="font-mono text-xs">
          {abbreviateHash(seed.declared_hash)}
        </code>
      );
    },
  }),
  helper.display({
    id: "source",
    header: "Source",
    enableSorting: false,
    cell: (info) => HASH_SOURCE_LABELS[info.row.original.hash_source],
  }),
  helper.display({
    id: "last-result",
    header: "Last result",
    enableSorting: false,
    cell: (info) => {
      const seed = info.row.original;
      return (
        <span className="flex flex-wrap items-center gap-2">
          <ResultStatusBadge status={seed.last_reset_status} />
          {seed.last_reset_at === null ? null : (
            <span className="text-xs text-muted-foreground">
              <DateTime value={seed.last_reset_at} />
            </span>
          )}
        </span>
      );
    },
  }),
  helper.display({
    id: "script",
    header: "Reset script",
    enableSorting: false,
    cell: (info) => (info.row.original.has_reset_script ? "Yes" : "No"),
  }),
]);

export interface SeedVersionsProps {
  seeds: readonly Seed[] | undefined;
  selectedId: string | null;
  onSelect: (seedId: string) => void;
  loadedCount: number;
  total: number | null | undefined;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetching: boolean;
  onLoadMore: () => void;
}

export function SeedVersions({
  seeds,
  selectedId,
  onSelect,
  loadedCount,
  total,
  hasNextPage,
  isFetchingNextPage,
  isFetching,
  onLoadMore,
}: SeedVersionsProps) {
  return (
    <SeedSelectionContext value={{ selectedId, onSelect }}>
      <DataTable<Seed>
        label="Seed versions"
        columns={columns}
        data={seeds}
        getRowId={(row) => row.id}
        isFetching={isFetching}
        getRowProps={(row) => ({
          "data-state": row.id === selectedId ? "selected" : undefined,
          "data-seed-id": row.id,
        })}
        footer={
          <DataTableFooter
            noun="version"
            loadedCount={loadedCount}
            total={total}
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            onLoadMore={onLoadMore}
          />
        }
      />
    </SeedSelectionContext>
  );
}
