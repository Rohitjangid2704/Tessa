import type { CSSProperties } from "react";
import { pluralize } from "@/features/bundles/format";
import { cn } from "@/lib/utils";
import type { AreaRow } from "../grid-model";
import { CELL_STATUSES, CELL_STATUS_LABELS } from "../labels";
import { CELL_STATUS_STYLES, CellStatusIcon } from "./cell-status";

export interface AreaGroupProps {
  row: AreaRow;
  rowIndex: number;
  style?: CSSProperties;
  className?: string;
}

export function AreaGroup({ row, rowIndex, style, className }: AreaGroupProps) {
  return (
    <div
      role="row"
      aria-rowindex={rowIndex}
      data-slot="area-group"
      data-area={row.area}
      style={style}
      className={cn("flex items-center", className)}
    >
      <div
        role="rowheader"
        className="sticky left-0 flex w-full min-w-0 flex-wrap items-center gap-x-4 gap-y-1 bg-muted/60 px-3 py-1.5"
      >
        <span className="text-sm font-semibold">{row.area}</span>
        <span className="text-xs text-muted-foreground">
          {pluralize(row.featureCount, "feature")}
        </span>
        <ul aria-label={`Cells in ${row.area} by status`} className="flex flex-wrap gap-x-3 gap-y-1">
          {CELL_STATUSES.filter((status) => row.counts[status] > 0).map((status) => (
            <li
              key={status}
              className={cn("inline-flex items-center gap-1 text-xs", CELL_STATUS_STYLES[status].text)}
            >
              <CellStatusIcon status={status} className="size-3" />
              <span className="tabular-nums">{row.counts[status]}</span>
              <span className="sr-only">{CELL_STATUS_LABELS[status]}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
