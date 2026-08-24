"use client";

import { Info } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { pluralize } from "@/features/bundles/format";
import { cn } from "@/lib/utils";
import type { OracleRow } from "../types";

export const CELL_PREVIEW_CHARACTERS = 80;

export type CellKind = "missing" | "null" | "text" | "json";

export interface CellView {
  kind: CellKind;
  preview: string;
  full: string;
  isLong: boolean;
}

export function columnsOf(rows: readonly OracleRow[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      seen.add(key);
    }
  }
  return [...seen];
}

function ellipsize(text: string): string {
  return `${text.slice(0, CELL_PREVIEW_CHARACTERS)}…`;
}

export function describeCell(row: OracleRow, column: string): CellView {
  if (!Object.hasOwn(row, column)) {
    return { kind: "missing", preview: "", full: "", isLong: false };
  }
  const value = row[column];
  if (value === null) {
    return { kind: "null", preview: "null", full: "null", isLong: false };
  }
  if (typeof value === "object") {
    const compact = JSON.stringify(value);
    const pretty = JSON.stringify(value, null, 2);
    const isLong = compact.length > CELL_PREVIEW_CHARACTERS;
    return {
      kind: "json",
      preview: isLong ? ellipsize(compact) : compact,
      full: pretty,
      isLong,
    };
  }
  const text = typeof value === "string" ? value : String(value);
  const isLong = text.length > CELL_PREVIEW_CHARACTERS;
  return { kind: "text", preview: isLong ? ellipsize(text) : text, full: text, isLong };
}

interface CellProps {
  view: CellView;
  column: string;
  rowNumber: number;
}

function Cell({ view, column, rowNumber }: CellProps) {
  const [expanded, setExpanded] = useState(false);
  const regionId = useId();
  if (view.kind === "missing") {
    return (
      <span title="This row has no value for this column" className="text-muted-foreground">
        <span aria-hidden="true">—</span>
        <span className="sr-only">no value</span>
      </span>
    );
  }
  const shown = expanded ? view.full : view.preview;
  return (
    <div className="flex flex-col items-start gap-1">
      <span
        id={regionId}
        className={cn(
          "break-words",
          view.kind === "null" && "text-muted-foreground italic",
          view.kind === "json" && "font-mono text-xs",
          expanded ? "whitespace-pre-wrap" : "whitespace-normal",
        )}
      >
        {shown}
      </span>
      {view.isLong ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto p-0 text-xs"
          aria-expanded={expanded}
          aria-controls={regionId}
          aria-label={`${expanded ? "Show less" : "Show more"} of ${column} in row ${rowNumber}`}
          onClick={() => setExpanded((previous) => !previous)}
        >
          {expanded ? "Show less" : "Show more"}
        </Button>
      ) : null}
    </div>
  );
}

export interface RowsTableProps {
  rows: readonly OracleRow[];
  truncated: boolean;
  label?: string;
  className?: string;
}

export function RowsTable({
  rows,
  truncated,
  label = "Rows returned by the query",
  className,
}: RowsTableProps) {
  const columns = columnsOf(rows);
  return (
    <div data-slot="rows-table" className={cn("flex flex-col gap-3", className)}>
      {truncated ? (
        <div
          role="note"
          data-slot="rows-truncated"
          className="flex items-start gap-2 rounded-lg border border-verdict-flaky-fg/25 bg-verdict-flaky-bg px-3 py-2 text-sm text-verdict-flaky-fg"
        >
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <p>
            The result is cut: only the first {pluralize(rows.length, "row")} are stored and shown.
            The query returned more.
          </p>
        </div>
      ) : null}
      {rows.length === 0 ? (
        <p
          data-slot="rows-empty"
          className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground"
        >
          The query returned no rows. That is still a valid result.
        </p>
      ) : (
        <div
          role="region"
          aria-label={label}
          tabIndex={0}
          className="max-h-[32rem] overflow-auto rounded-lg border focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <table className="w-full caption-bottom border-collapse text-sm">
            <caption className="sr-only">
              {label}: {pluralize(rows.length, "row")}, {pluralize(columns.length, "column")}
            </caption>
            <thead className="sticky top-0 z-10 bg-muted text-left">
              <tr>
                <th
                  scope="col"
                  className="px-3 py-2 font-medium text-muted-foreground tabular-nums"
                >
                  #
                </th>
                {columns.map((column) => (
                  <th
                    key={column}
                    scope="col"
                    className="px-3 py-2 font-mono text-xs font-medium whitespace-nowrap"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index} className="border-t align-top">
                  <th
                    scope="row"
                    className="px-3 py-2 font-normal text-muted-foreground tabular-nums"
                  >
                    {index + 1}
                  </th>
                  {columns.map((column) => (
                    <td key={column} className="max-w-md px-3 py-2">
                      <Cell
                        view={describeCell(row, column)}
                        column={column}
                        rowNumber={index + 1}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
