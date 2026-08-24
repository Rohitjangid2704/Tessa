"use client";

import { LoaderCircle, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { pluralize } from "@/features/bundles/format";
import { describeApiError } from "@/lib/api/errors";
import { formatUsd } from "@/lib/format-usd";
import { cn } from "@/lib/utils";
import type { PlanPreviewState } from "../use-plan-preview";
import type { PlanPreview } from "../types";
import { SkippedPopover, WarningsPopover } from "./preview-details";

export interface PlanSummaryBarProps {
  selectedCount: number;
  preview: PlanPreviewState;
  onClearSelection: () => void;
  actions: ReactNode;
  notice?: ReactNode;
}

function Stat({ label, value, muted }: { label: string; value: string; muted: boolean }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("font-medium tabular-nums", muted && "text-muted-foreground")}>{value}</dd>
    </div>
  );
}

function describeBudget(data: PlanPreview): string {
  const { max_usd: maxUsd, max_minutes: maxMinutes } = data.effective_budget;
  return `${formatUsd(maxUsd)} or ${maxMinutes} min`;
}

function announce(selectedCount: number, preview: PlanPreviewState): string {
  if (selectedCount === 0) {
    return "Nothing selected";
  }
  if (preview.data === undefined || preview.isPlaceholderData) {
    return "";
  }
  const { cells_total: cells, scenarios_estimated: scenarios, skipped } = preview.data;
  const skippedText = skipped.length === 0 ? "" : `, ${skipped.length} skipped`;
  const costUsd = preview.data.estimated_cost_usd;
  const costText = costUsd === null ? "" : `, estimated cost about ${formatUsd(costUsd)}`;
  return `Preview: ${pluralize(cells, "cell")}, about ${pluralize(scenarios, "scenario")}${skippedText}${costText}`;
}

function PreviewError({ preview }: { preview: PlanPreviewState }) {
  const requestId = readRequestId(preview.error);
  return (
    <div
      role="alert"
      data-slot="preview-error"
      className="flex flex-wrap items-center gap-2 text-sm"
    >
      <TriangleAlert aria-hidden="true" className="size-4 text-destructive" />
      <span>Could not preview this selection. {describeApiError(preview.error)}</span>
      {requestId === null ? null : (
        <span className="font-mono text-xs text-muted-foreground">Request ID: {requestId}</span>
      )}
      <Button type="button" variant="outline" size="sm" onClick={preview.retry}>
        Try again
      </Button>
    </div>
  );
}

function PreviewLoading() {
  return (
    <div data-slot="preview-loading" className="flex items-center gap-3">
      <span className="sr-only">Estimating the plan</span>
      <Skeleton aria-hidden="true" className="h-5 w-20" />
      <Skeleton aria-hidden="true" className="h-5 w-28" />
      <Skeleton aria-hidden="true" className="h-5 w-36" />
    </div>
  );
}

function PreviewStats({ data, stale }: { data: PlanPreview; stale: boolean }) {
  return (
    <>
      <dl className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm" data-stale={stale}>
        <Stat label="Cells" value={String(data.cells_total)} muted={stale} />
        <Stat label="Scenarios, about" value={String(data.scenarios_estimated)} muted={stale} />
        <Stat label="Stops at" value={describeBudget(data)} muted={stale} />
        {data.estimated_cost_usd === null ? null : (
          <Stat
            label="Estimated cost, about"
            value={formatUsd(data.estimated_cost_usd)}
            muted={stale}
          />
        )}
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        <SkippedPopover skipped={data.skipped} />
        <WarningsPopover warnings={data.warnings} />
      </div>
    </>
  );
}

function PreviewSection({
  selectedCount,
  preview,
}: Pick<PlanSummaryBarProps, "selectedCount" | "preview">) {
  if (selectedCount === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Tick features or whole areas to see what a run would cover.
      </p>
    );
  }
  if (preview.isError) {
    return <PreviewError preview={preview} />;
  }
  if (preview.data === undefined) {
    return <PreviewLoading />;
  }
  return (
    <>
      <PreviewStats data={preview.data} stale={preview.isPlaceholderData} />
      {preview.isUpdating ? (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <LoaderCircle aria-hidden="true" className="size-3 animate-spin" />
          Updating
        </span>
      ) : null}
    </>
  );
}

export function PlanSummaryBar({
  selectedCount,
  preview,
  onClearSelection,
  actions,
  notice,
}: PlanSummaryBarProps) {
  return (
    <section
      aria-label="Plan summary"
      aria-busy={preview.isUpdating}
      data-slot="plan-summary-bar"
      className="sticky bottom-0 z-10 -mx-4 mt-2 flex flex-col gap-3 border-t bg-background px-4 py-3 md:-mx-6 md:px-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-5 gap-y-2">
          <p data-slot="selected-count" className="text-sm font-medium tabular-nums">
            {pluralize(selectedCount, "feature")} selected
          </p>
          <PreviewSection selectedCount={selectedCount} preview={preview} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {selectedCount === 0 ? null : (
            <Button type="button" variant="ghost" onClick={onClearSelection}>
              Clear selection
            </Button>
          )}
          {actions}
        </div>
      </div>
      {notice}
      <p role="status" className="sr-only">
        {announce(selectedCount, preview)}
      </p>
    </section>
  );
}
