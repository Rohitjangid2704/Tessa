"use client";

import { useQuery } from "@tanstack/react-query";
import { ShieldAlert, TriangleAlert } from "lucide-react";
import { useReducer, useState } from "react";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { bundleDetailQuery } from "@/features/bundles/queries";
import { pluralize } from "@/features/bundles/format";
import { planQuery } from "@/features/plans/queries";
import { CurrentTargetGate } from "@/features/targets/current-target-gate";
import { useTarget } from "@/features/targets/queries";
import { describeApiError } from "@/lib/api/errors";
import { useCan } from "@/lib/auth/can";
import { useUrlFilters } from "@/lib/url-state";
import { useThrottledValue } from "@/lib/use-throttled-value";
import type { CoverageAccess } from "../access";
import { areaNamesOf, buildGridModel, rangeBetween } from "../grid-model";
import { BASELINE_PLAN_LABEL } from "../labels";
import { coverageQuery } from "../queries";
import { coverageFiltersCodec } from "../schemas";
import {
  createInitialSelection,
  itemIdsCoveringAll,
  proposalItemIdsOf,
  proposedCellCount,
  selectedCellsOf,
  selectionReducer,
  summarizeSelection,
} from "../selection";
import type { CellStatus, CoverageCell, CoverageMap, RunHandle } from "../types";
import { useAuthorPrompt } from "../use-author-prompt";
import { useCoverageFeed } from "../use-coverage-feed";
import { AuthorPromptDialog } from "./author-prompt-dialog";
import { CellSheet } from "./cell-sheet";
import { CoverageError, NoFeatures, NoMatches } from "./coverage-states";
import { CoverageSkeleton } from "./coverage-skeleton";
import { CoverageToolbar } from "./coverage-toolbar";
import { GenerateDialog } from "./generate-dialog";
import { GenerationBanner } from "./generation-banner";
import { HeatmapGrid } from "./heatmap-grid";
import { Legend } from "./legend";
import { SelectionBar } from "./selection-bar";

const ANNOUNCE_INTERVAL_MS = 2000;
const UNNAMED_PLAN = "Untitled plan";

interface GenerateState {
  open: boolean;
  cells: readonly CoverageCell[];
}

function PlanLine({ map }: { map: CoverageMap }) {
  const plan = useQuery(planQuery(map.plan_id));
  const bundle = useQuery(bundleDetailQuery(map.bundle_id));
  const planName =
    plan.data === undefined
      ? "the plan"
      : plan.data.is_coverage_baseline
        ? BASELINE_PLAN_LABEL
        : (plan.data.name ?? UNNAMED_PLAN);
  const version = bundle.data === undefined ? "loading" : String(bundle.data.version);

  return (
    <div data-slot="coverage-plan-line" className="flex flex-col gap-0.5 text-sm">
      <p>
        Showing <span className="font-medium">{planName}</span>, bundle version{" "}
        <span className="font-medium tabular-nums">{version}</span>
      </p>
      <p className="text-xs text-muted-foreground">
        A new bundle version starts a new baseline, so the cells and totals reset after an upload.
      </p>
    </div>
  );
}

interface CoverageContentProps {
  targetId: string;
  onRestartFeed: () => void;
}

function CoverageContent({ targetId, onRestartFeed }: CoverageContentProps) {
  const { values, setFilters } = useUrlFilters(coverageFiltersCodec);
  const planId = values.plan_id ?? null;
  const statusFilter = values.status ?? [];
  const areaFilter = values.area ?? [];
  const canGenerate = useCan("coverage.generate");
  const canAuthor = useCan("prompts.issue");
  const target = useTarget(targetId);
  const productionTarget = target.data?.tier === "production";
  const access: CoverageAccess = { canGenerate, canAuthor, productionTarget };
  const query = useQuery(coverageQuery({ targetId, planId }));
  const { stream, activity } = useCoverageFeed(targetId);
  const authorPrompt = useAuthorPrompt(targetId);
  const [selection, dispatchSelection] = useReducer(
    selectionReducer,
    undefined,
    createInitialSelection,
  );
  const [activeCellId, setActiveCellId] = useState<string | null>(null);
  const [sheetCellId, setSheetCellId] = useState<string | null>(null);
  const [generate, setGenerate] = useState<GenerateState>({ open: false, cells: [] });
  const [trackedRunIds, setTrackedRunIds] = useState<readonly string[]>([]);
  const updateAnnouncement = useThrottledValue(
    activity.batches === 0 ? "" : `${pluralize(activity.lastBatchSize, "cell")} updated`,
    ANNOUNCE_INTERVAL_MS,
  );

  const map = query.data;
  const model = map === undefined ? null : buildGridModel(map, { status: statusFilter, area: areaFilter });
  const selectedCells =
    model === null ? [] : selectedCellsOf(selection.ids, model.cellsById, model.cellOrder);
  const summary = summarizeSelection(selectedCells);
  const sheetCell =
    map === undefined || sheetCellId === null
      ? null
      : (map.cells.find((cell) => cell.id === sheetCellId) ?? null);
  const sheetTitle =
    map === undefined || sheetCell === null
      ? ""
      : (map.rows.find((row) => row.feature_id === sheetCell.feature_id)?.title ??
        sheetCell.feature_id);

  function clearFilters(): void {
    setFilters({ status: undefined, area: undefined });
  }

  function toggleStatus(status: CellStatus): void {
    const next = statusFilter.includes(status)
      ? statusFilter.filter((candidate) => candidate !== status)
      : [...statusFilter, status];
    setFilters({ status: next.length === 0 ? undefined : next });
  }

  function changePlan(next: string | null): void {
    dispatchSelection({ type: "clear" });
    setSheetCellId(null);
    setFilters({ plan_id: next ?? undefined }, { history: "push" });
  }

  function activateCell(cell: CoverageCell, shiftKey: boolean): void {
    setActiveCellId(cell.id);
    if (shiftKey && model !== null) {
      const anchor = selection.anchor ?? activeCellId ?? cell.id;
      dispatchSelection({
        type: "select_range",
        cellIds: rangeBetween(model, anchor, cell.id),
        anchor,
      });
      return;
    }
    if (selection.mode) {
      dispatchSelection({ type: "toggle", cellId: cell.id });
      return;
    }
    setSheetCellId(cell.id);
  }

  function openGenerate(cells: readonly CoverageCell[]): void {
    if (cells.length > 0) {
      setGenerate({ open: true, cells });
    }
  }

  function handleStarted(handle: RunHandle): void {
    setTrackedRunIds((previous) =>
      previous.includes(handle.run_id) ? previous : [...previous, handle.run_id],
    );
    dispatchSelection({ type: "clear" });
  }

  function generateFromSheet(cell: CoverageCell): void {
    setSheetCellId(null);
    openGenerate([cell]);
  }

  function authorFromSheet(cell: CoverageCell): void {
    setSheetCellId(null);
    authorPrompt.request([cell.id], proposalItemIdsOf(cell));
  }

  function renderBody(current: CoverageMap) {
    if (model === null) {
      return null;
    }
    if (current.rows.length === 0 || current.cells.length === 0) {
      return <NoFeatures targetId={targetId} />;
    }
    const requestId = readRequestId(query.error);
    return (
      <>
        <PlanLine map={current} />
        {query.isError ? (
          <Alert variant="destructive" role="alert" data-slot="coverage-refresh-error">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>Could not refresh the map</AlertTitle>
            <AlertDescription>
              <p>{describeApiError(query.error)} The map below may be out of date.</p>
              {requestId === null ? null : (
                <p className="font-mono text-xs">Request ID: {requestId}</p>
              )}
              <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        <GenerationBanner targetId={targetId} trackedRunIds={trackedRunIds} />
        <Legend
          totals={current.totals}
          active={statusFilter}
          onToggle={toggleStatus}
          onClear={() => setFilters({ status: undefined })}
          proposedCount={proposedCellCount(current.cells)}
        />
        <p className="text-xs text-muted-foreground">
          {selection.mode
            ? "Selection mode: click cells to select them, or hold Shift and click to select a range."
            : "Use the arrow keys to move between cells and Enter to open one."}
        </p>
        {model.visibleCellCount === 0 ? (
          <NoMatches onClear={clearFilters} />
        ) : (
          <div aria-busy={query.isFetching} data-slot="coverage-grid-wrapper">
            <HeatmapGrid
              model={model}
              activeCellId={activeCellId}
              onActiveCellChange={setActiveCellId}
              selectionMode={selection.mode}
              selectedIds={selection.ids}
              flashes={activity.flashes}
              onCellActivate={activateCell}
              label={`Coverage map, ${pluralize(model.visibleCellCount, "cell")}`}
            />
          </div>
        )}
        {selectedCells.length > 0 ? (
          <SelectionBar
            summary={summary}
            access={access}
            onGenerate={() => openGenerate(summary.generatable)}
            onAuthor={() =>
              authorPrompt.request(
                summary.authorable.map((cell) => cell.id),
                itemIdsCoveringAll(summary.authorable) ?? [],
              )
            }
            onClear={() => dispatchSelection({ type: "clear" })}
          />
        ) : null}
        <CellSheet
          targetId={targetId}
          cell={sheetCell}
          featureTitle={sheetTitle}
          open={sheetCell !== null}
          onOpenChange={(open) => {
            if (!open) {
              setSheetCellId(null);
            }
          }}
          access={access}
          onGenerate={generateFromSheet}
          onAuthor={authorFromSheet}
        />
        <GenerateDialog
          open={generate.open}
          onOpenChange={(open) => setGenerate((previous) => ({ ...previous, open }))}
          planId={current.plan_id}
          cells={generate.cells}
          access={access}
          onStarted={handleStarted}
        />
      </>
    );
  }

  return (
    <div data-slot="coverage-view" className="flex flex-col gap-4">
      {productionTarget ? (
        <Alert role="status" data-slot="coverage-production">
          <ShieldAlert aria-hidden="true" />
          <AlertTitle>This is a production target</AlertTitle>
          <AlertDescription>
            Generate is disabled here because generated scenarios are never created against
            production. Copy the Author prompt to fill cells with Claude Code instead.
          </AlertDescription>
        </Alert>
      ) : null}
      <CoverageToolbar
        targetId={targetId}
        planId={planId}
        onPlanChange={changePlan}
        areas={map === undefined ? [] : areaNamesOf(map)}
        area={areaFilter[0]}
        onAreaChange={(area) => setFilters({ area: area === undefined ? undefined : [area] })}
        selectionMode={selection.mode}
        onSelectionModeChange={(mode) => dispatchSelection({ type: "set_mode", mode })}
        stream={stream}
        onRestartFeed={onRestartFeed}
      />
      {query.isPending ? <CoverageSkeleton /> : null}
      {query.isError && map === undefined ? (
        <CoverageError error={query.error} targetId={targetId} onRetry={() => void query.refetch()} />
      ) : null}
      {map === undefined ? null : renderBody(map)}
      <AuthorPromptDialog targetId={targetId} prompt={authorPrompt} />
      <p role="status" className="sr-only" data-slot="coverage-updates">
        {updateAnnouncement}
      </p>
    </div>
  );
}

export function CoverageView() {
  const [feedEpoch, setFeedEpoch] = useState(0);
  return (
    <CurrentTargetGate
      title="Choose a target"
      description="Coverage shows what is tested for one target. Pick a target to see its map."
    >
      {(targetId) => (
        <CoverageContent
          key={`${targetId}:${feedEpoch}`}
          targetId={targetId}
          onRestartFeed={() => setFeedEpoch((epoch) => epoch + 1)}
        />
      )}
    </CurrentTargetGate>
  );
}
