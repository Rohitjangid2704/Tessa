"use client";

import {
  functionalUpdate,
  useTable,
  type RowData,
  type SortingState,
  type TableOptions,
  type Updater,
} from "@tanstack/react-table";
import type { ComponentProps, ReactNode } from "react";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { describeApiError } from "@/lib/api/errors";
import { cn } from "@/lib/utils";
import { dataTableFeatures, type DataTableAlign, type DataTableFeatures } from "./features";
import { SortButton, sortAriaValue } from "./sort-button";

export const DEFAULT_SKELETON_ROWS = 5;

const ALIGN_CLASSES: Record<DataTableAlign, string> = {
  start: "text-left",
  center: "text-center",
  end: "text-right",
};

const EMPTY_ROWS: readonly [] = [];

export type DataTableRowProps = ComponentProps<"tr"> &
  Partial<Record<`data-${string}`, string | number | boolean>>;

export interface DataTableProps<TData extends RowData> {
  label: string;
  columns: TableOptions<DataTableFeatures, TData>["columns"];
  data: readonly TData[] | undefined;
  getRowId: (row: TData) => string;
  isLoading?: boolean;
  isFetching?: boolean;
  error?: unknown;
  onRetry?: () => void;
  emptyState?: ReactNode;
  sorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;
  manualSorting?: boolean;
  skeletonRows?: number;
  footer?: ReactNode;
  getRowProps?: (row: TData) => DataTableRowProps;
  className?: string;
}

function hasError(error: unknown): boolean {
  return error !== undefined && error !== null;
}

export function DataTable<TData extends RowData>({
  label,
  columns,
  data,
  getRowId,
  isLoading = false,
  isFetching = false,
  error,
  onRetry,
  emptyState,
  sorting,
  onSortingChange,
  manualSorting = false,
  skeletonRows = DEFAULT_SKELETON_ROWS,
  footer,
  getRowProps,
  className,
}: DataTableProps<TData>) {
  const sortingControlled = sorting !== undefined && onSortingChange !== undefined;
  const table = useTable({
    features: dataTableFeatures,
    columns,
    data: data ?? EMPTY_ROWS,
    getRowId,
    manualSorting,
    enableMultiSort: false,
    ...(sortingControlled
      ? {
          state: { sorting },
          onSortingChange: (updater: Updater<SortingState>) =>
            onSortingChange(functionalUpdate(updater, sorting)),
        }
      : {}),
  });

  const rows = table.getRowModel().rows;
  const hasRows = rows.length > 0;
  const showLoading = isLoading && !hasRows;
  const showError = hasError(error) && !hasRows && !isLoading;
  const showEmpty = !showLoading && !showError && !hasRows;

  if (showError) {
    return (
      <div data-slot="data-table" className={cn("flex flex-col gap-3", className)}>
        <ErrorState
          title={`Could not load ${label.toLowerCase()}`}
          description={describeApiError(error)}
          requestId={readRequestId(error)}
          onRetry={onRetry}
        />
      </div>
    );
  }

  if (showEmpty) {
    return (
      <div data-slot="data-table" className={cn("flex flex-col gap-3", className)}>
        {emptyState ?? <EmptyState title={`No ${label.toLowerCase()} yet`} />}
      </div>
    );
  }

  return (
    <div
      data-slot="data-table"
      aria-busy={showLoading || isFetching}
      className={cn("flex flex-col gap-3", className)}
    >
      {showLoading ? (
        <p role="status" className="sr-only">
          Loading {label.toLowerCase()}
        </p>
      ) : null}
      {hasError(error) && hasRows ? (
        <ErrorState
          title={`Could not refresh ${label.toLowerCase()}`}
          description={describeApiError(error)}
          requestId={readRequestId(error)}
          onRetry={onRetry}
          className="py-4"
        />
      ) : null}
      <div className="overflow-hidden rounded-xl border">
        <Table aria-label={label}>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {group.headers.map((header) => {
                  const meta = header.column.columnDef.meta;
                  const canSort = header.column.getCanSort();
                  const direction = header.column.getIsSorted();
                  const heading = header.column.columnDef.header;
                  return (
                    <TableHead
                      key={header.id}
                      colSpan={header.colSpan}
                      aria-sort={canSort ? sortAriaValue(direction) : undefined}
                      className={cn(
                        meta?.align && ALIGN_CLASSES[meta.align],
                        meta?.headerClassName,
                      )}
                    >
                      {header.isPlaceholder ? null : canSort ? (
                        <SortButton
                          label={typeof heading === "string" ? heading : undefined}
                          direction={direction}
                          align={meta?.align}
                          onToggle={() => header.column.toggleSorting()}
                        >
                          <table.FlexRender header={header} />
                        </SortButton>
                      ) : (
                        <table.FlexRender header={header} />
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {showLoading
              ? Array.from({ length: skeletonRows }, (_, rowIndex) => (
                  <TableRow key={rowIndex} aria-hidden="true" className="hover:bg-transparent">
                    {columns.map((_column, columnIndex) => (
                      <TableCell key={columnIndex}>
                        <Skeleton className="h-4 w-full max-w-40" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : rows.map((row) => (
                  <TableRow key={row.id} {...getRowProps?.(row.original)}>
                    {row.getAllCells().map((cell) => {
                      const meta = cell.column.columnDef.meta;
                      return (
                        <TableCell
                          key={cell.id}
                          className={cn(
                            meta?.align && ALIGN_CLASSES[meta.align],
                            meta?.cellClassName,
                          )}
                        >
                          <table.FlexRender cell={cell} />
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </div>
      {footer}
    </div>
  );
}
