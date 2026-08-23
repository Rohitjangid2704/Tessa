"use client";

import { Lightbulb } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { totalOfTotals } from "../grid-model";
import { CELL_STATUSES, CELL_STATUS_DESCRIPTIONS, CELL_STATUS_LABELS } from "../labels";
import type { CellStatus, CoverageTotals } from "../types";
import { CELL_STATUS_STYLES, CellStatusIcon } from "./cell-status";

export interface LegendProps {
  totals: CoverageTotals;
  active: readonly CellStatus[];
  onToggle: (status: CellStatus) => void;
  onClear: () => void;
  proposedCount?: number;
}

export function Legend({ totals, active, onToggle, onClear, proposedCount = 0 }: LegendProps) {
  const total = totalOfTotals(totals);
  return (
    <section
      aria-label="Cell status legend"
      data-slot="coverage-legend"
      className="flex flex-wrap items-center gap-2"
    >
      <p className="mr-1 text-sm text-muted-foreground" data-slot="coverage-total">
        <span className="font-medium text-foreground tabular-nums">{total}</span>{" "}
        {total === 1 ? "cell" : "cells"}
      </p>
      <ul className="flex flex-wrap items-center gap-2">
        {CELL_STATUSES.map((status) => {
          const style = CELL_STATUS_STYLES[status];
          const pressed = active.includes(status);
          return (
            <li key={status}>
              <button
                type="button"
                aria-pressed={pressed}
                title={CELL_STATUS_DESCRIPTIONS[status]}
                onClick={() => onToggle(status)}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-4xl border px-2.5 text-xs font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/60",
                  style.tone,
                  style.outline,
                  style.pattern,
                  pressed && "ring-2 ring-foreground",
                )}
              >
                <CellStatusIcon status={status} />
                {CELL_STATUS_LABELS[status]}
                <span className="tabular-nums" data-slot="legend-count">
                  {totals[status]}
                </span>
              </button>
            </li>
          );
        })}
        {proposedCount === 0 ? null : (
          <li>
            <span
              data-slot="legend-proposed"
              title="The cell is part of an item of the test proposal"
              className="inline-flex h-7 items-center gap-1.5 rounded-4xl border border-proposed-fg/25 bg-proposed-bg px-2.5 text-xs font-medium text-proposed-fg"
            >
              <Lightbulb aria-hidden="true" className="size-3.5" />
              Proposed
              <span className="tabular-nums" data-slot="legend-proposed-count">
                {proposedCount}
              </span>
            </span>
          </li>
        )}
      </ul>
      {active.length === 0 ? null : (
        <Button type="button" variant="ghost" size="sm" onClick={onClear}>
          Clear status filter
        </Button>
      )}
    </section>
  );
}
