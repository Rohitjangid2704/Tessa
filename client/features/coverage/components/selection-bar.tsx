"use client";

import { ClipboardCopy, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pluralize } from "@/features/bundles/format";
import { ClaudeCodeCommand } from "@/features/claude-code/components/claude-code-command";
import { cn } from "@/lib/utils";
import { authorBlockedReason, generateBlockedReason, type CoverageAccess } from "../access";
import { CELL_STATUSES, CELL_STATUS_LABELS } from "../labels";
import { itemIdsCoveringAll, type SelectionSummary } from "../selection";
import { CELL_STATUS_STYLES, CellStatusIcon } from "./cell-status";

export interface SelectionBarProps {
  summary: SelectionSummary;
  access: CoverageAccess;
  onGenerate: () => void;
  onAuthor: () => void;
  onClear: () => void;
}

export function SelectionBar({ summary, access, onGenerate, onAuthor, onClear }: SelectionBarProps) {
  const generateReason = generateBlockedReason(access);
  const authorReason = authorBlockedReason(access);
  const generateCount = summary.generatable.length;
  const authorCount = summary.authorable.length;
  const itemIds = itemIdsCoveringAll(summary.authorable);
  const ignored = summary.total - new Set([...summary.generatable, ...summary.authorable]).size;

  return (
    <section
      aria-label="Selected cells"
      data-slot="selection-bar"
      className="sticky bottom-0 z-10 -mx-4 mt-2 flex flex-col gap-3 border-t bg-background px-4 py-3 md:-mx-6 md:px-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-sm font-medium tabular-nums" data-slot="selected-cell-count">
            {pluralize(summary.total, "cell")} selected
          </p>
          <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {CELL_STATUSES.filter((status) => summary.byStatus[status] > 0).map((status) => (
              <li
                key={status}
                className={cn("inline-flex items-center gap-1 text-xs", CELL_STATUS_STYLES[status].text)}
              >
                <CellStatusIcon status={status} className="size-3" />
                <span className="tabular-nums">{summary.byStatus[status]}</span>
                <span>{CELL_STATUS_LABELS[status]}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="ghost" onClick={onClear}>
            Clear selection
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={authorReason !== null || authorCount === 0}
            onClick={onAuthor}
          >
            <ClipboardCopy aria-hidden="true" data-icon="inline-start" />
            Copy Author prompt ({authorCount})
          </Button>
          <Button
            type="button"
            disabled={generateReason !== null || generateCount === 0}
            onClick={onGenerate}
          >
            <Sparkles aria-hidden="true" data-icon="inline-start" />
            Generate here ({generateCount})
          </Button>
        </div>
      </div>
      {authorCount === 0 ? null : (
        <ClaudeCodeCommand
          template="author"
          params={
            itemIds === null
              ? { cell_ids: summary.authorable.map((cell) => cell.id) }
              : { item_ids: itemIds }
          }
        />
      )}
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        {generateReason === null ? null : <p>{generateReason}</p>}
        {generateReason === null && generateCount === 0 ? (
          <p>Generate works on empty cells. Select at least one empty cell.</p>
        ) : null}
        {ignored > 0 ? (
          <p>
            {pluralize(ignored, "selected cell")} cannot be generated or authored here: generated,
            covered and blocked cells are left out of both actions.
          </p>
        ) : null}
      </div>
      <p role="status" className="sr-only">
        {pluralize(summary.total, "cell")} selected, {generateCount} empty
      </p>
    </section>
  );
}
