"use client";

import { useQuery } from "@tanstack/react-query";
import { LoaderCircle, Play, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type Dispatch } from "react";
import { toast } from "sonner";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CatalogExplorer } from "@/features/catalog/components/catalog-view";
import { catalogQuery, itemCount } from "@/features/catalog/queries";
import type { CatalogSelection } from "@/features/catalog/selection";
import type { Catalog } from "@/features/catalog/types";
import { settingsQuery } from "@/features/settings/queries";
import { useTarget } from "@/features/targets/queries";
import { describeApiError } from "@/lib/api/errors";
import { useCan, useCanDo } from "@/lib/auth/can";
import { runRoutes } from "@/lib/routes";
import { hasBudgetErrors, resolveBudgetInput } from "../budget-input";
import { useRunNow, useSavePlan, useUpdatePlan } from "../mutations";
import { buildPlanCreate, featureIdByItemId, selectedFeatureCount } from "../plan-selection";
import {
  classifyRunStartError,
  hasPlanFieldErrors,
  planFieldErrorsFromApiError,
} from "../run-errors";
import type { PlanBuilderAction, PlanBuilderState } from "../selection-reducer";
import type { Budget } from "../types";
import { usePlanPreview } from "../use-plan-preview";
import { useRequestedBundleId } from "../use-requested-bundle-id";
import { LoadedPlanLine, LoadNotices, ViewerNote } from "./builder-notices";
import { PlanNameDialog } from "./plan-name-dialog";
import { PlanOptions } from "./plan-options";
import { PlanSummaryBar } from "./plan-summary-bar";
import { ProductionBanner } from "./production-banner";
import { RunStartAlert } from "./run-start-alert";

export interface PlanBuilderProps {
  targetId: string;
  state: PlanBuilderState;
  dispatch: Dispatch<PlanBuilderAction>;
  onOpenSavedPlans: () => void;
}

const NO_FIELD_ERRORS = { other: [] as string[] };

export function PlanBuilder({ targetId, state, dispatch, onOpenSavedPlans }: PlanBuilderProps) {
  const router = useRouter();
  const { allowed: canSave, isPending: rolePending } = useCanDo("plans.save");
  const canRun = useCan("runs.start");
  const canEdit = canSave || canRun;
  const target = useTarget(targetId);
  const bundleId = useRequestedBundleId();
  const catalogResult = useQuery(catalogQuery({ targetId, bundleId, filters: {} }));
  const settings = useQuery(settingsQuery());
  const runNow = useRunNow();
  const savePlan = useSavePlan();
  const updatePlan = useUpdatePlan();
  const [saveOpen, setSaveOpen] = useState(false);

  const catalog = catalogResult.data;
  const readyCatalog: Catalog | null =
    catalog !== undefined && catalog.bundle_id !== null && itemCount(catalog) > 0 ? catalog : null;
  const productionTarget = target.data?.tier === "production";

  const settingsBudget: Budget | null =
    settings.data === undefined
      ? null
      : {
          max_usd: settings.data.budgets.default_max_usd,
          max_minutes: settings.data.budgets.default_max_minutes,
        };
  const resolution = resolveBudgetInput(
    { maxUsd: state.maxUsd, maxMinutes: state.maxMinutes },
    settingsBudget,
  );
  const budgetBlocked = hasBudgetErrors(resolution.errors);
  const selectedCount = selectedFeatureCount(state.featureIds, readyCatalog ?? undefined);
  const draft =
    readyCatalog !== null && selectedCount > 0 && !budgetBlocked
      ? buildPlanCreate({
          targetId,
          catalog: readyCatalog,
          state,
          budget: resolution.budget,
          saved: false,
        })
      : null;

  const preview = usePlanPreview(draft);
  const settledPreview = preview.data !== undefined && !preview.isPlaceholderData;
  const previewEmpty = settledPreview && preview.data?.cells_total === 0;
  const serverDefaultBudget =
    resolution.budget === undefined && settledPreview
      ? (preview.data?.effective_budget ?? null)
      : null;
  const budgetPlaceholders = serverDefaultBudget ?? settingsBudget;
  const serverErrors = preview.isError
    ? planFieldErrorsFromApiError(preview.error)
    : NO_FIELD_ERRORS;
  const canAct = draft !== null && !previewEmpty;

  const runProblem = runNow.error === null ? null : classifyRunStartError(runNow.error);
  const updateRequestId = readRequestId(updatePlan.error);

  function edit(action: PlanBuilderAction): void {
    if (runNow.error !== null) {
      runNow.reset();
    }
    if (updatePlan.error !== null) {
      updatePlan.reset();
    }
    dispatch(action);
  }

  const featureByItem = readyCatalog === null ? null : featureIdByItemId(readyCatalog);
  const selection: CatalogSelection | undefined =
    canEdit && featureByItem !== null
      ? {
          isSelected: (itemId) => {
            const featureId = featureByItem.get(itemId);
            return featureId !== undefined && state.featureIds.has(featureId);
          },
          onToggleItem: (item, selected) =>
            edit({ type: "toggle_feature", featureId: item.feature_id, selected }),
          onToggleArea: (area, selected) =>
            edit({
              type: "toggle_area",
              featureIds: area.items.map((item) => item.feature_id),
              selected,
            }),
        }
      : undefined;

  function startRun(): void {
    if (draft === null) {
      return;
    }
    runNow.run(
      { plan: draft, resetSeed: state.resetSeed && !productionTarget },
      { onSuccess: (handle) => router.push(runRoutes.detail(handle.run_id)) },
    );
  }

  function openSaveDialog(): void {
    savePlan.reset();
    setSaveOpen(true);
  }

  function changeSaveDialog(open: boolean): void {
    setSaveOpen(open);
    if (!open) {
      savePlan.reset();
    }
  }

  function saveAs(name: string): void {
    if (draft === null) {
      return;
    }
    savePlan.save(
      { ...draft, name },
      {
        onSuccess: (plan) => {
          setSaveOpen(false);
          dispatch({ type: "link_plan", plan: { id: plan.id, name: plan.name } });
          toast.success(`Saved plan "${name}"`, {
            action: { label: "Saved plans", onClick: onOpenSavedPlans },
          });
        },
      },
    );
  }

  function updateLoadedPlan(): void {
    if (draft === null || state.loadedPlan === null) {
      return;
    }
    updatePlan.mutate(
      { planId: state.loadedPlan.id, update: { selection: draft.selection } },
      {
        onSuccess: (plan) => {
          dispatch({ type: "link_plan", plan: { id: plan.id, name: plan.name } });
          toast.success("Saved plan updated");
        },
      },
    );
  }

  const actions = (
    <>
      {state.loadedPlan === null ? null : (
        <Button
          type="button"
          variant="outline"
          disabled={!canSave || !canAct || updatePlan.isPending}
          aria-busy={updatePlan.isPending}
          onClick={updateLoadedPlan}
        >
          {updatePlan.isPending ? "Updating plan" : "Update saved plan"}
        </Button>
      )}
      <Button
        type="button"
        variant="outline"
        disabled={!canSave || !canAct}
        onClick={openSaveDialog}
      >
        Save plan
      </Button>
      <Button
        type="button"
        disabled={!canRun || !canAct || runNow.isPending}
        aria-busy={runNow.isPending}
        onClick={startRun}
      >
        {runNow.isPending ? (
          <LoaderCircle aria-hidden="true" data-icon="inline-start" className="animate-spin" />
        ) : (
          <Play aria-hidden="true" data-icon="inline-start" />
        )}
        {runNow.isPending ? "Starting run" : "Run now"}
      </Button>
    </>
  );

  const notice = (
    <>
      {runProblem === null ? null : (
        <RunStartAlert problem={runProblem} error={runNow.error} targetId={targetId} />
      )}
      {updatePlan.error === null ? null : (
        <Alert variant="destructive" data-slot="update-plan-alert">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription>
            <p>Could not update the saved plan. {describeApiError(updatePlan.error)}</p>
            {updateRequestId === null ? null : (
              <p className="font-mono text-xs">Request ID: {updateRequestId}</p>
            )}
          </AlertDescription>
        </Alert>
      )}
      {budgetBlocked && selectedCount > 0 ? (
        <p role="status" className="text-sm text-destructive">
          Fix the budget limits to preview, save or run this plan.
        </p>
      ) : null}
      {previewEmpty && !hasPlanFieldErrors(serverErrors) ? (
        <p role="status" data-slot="empty-preview" className="text-sm text-muted-foreground">
          This selection expands to no runnable cell. Pick other features, roles or an interface
          mode.
        </p>
      ) : null}
    </>
  );

  return (
    <div data-slot="plan-builder" className="flex flex-col gap-6">
      {productionTarget && target.data !== undefined ? (
        <ProductionBanner
          targetId={targetId}
          targetName={target.data.name}
          allowProduction={target.data.allow_production}
        />
      ) : null}
      {!rolePending && !canEdit ? <ViewerNote /> : null}
      {canEdit ? (
        <LoadNotices notices={state.notices} onDismiss={() => edit({ type: "dismiss_notices" })} />
      ) : null}
      {canEdit && state.loadedPlan !== null ? (
        <LoadedPlanLine name={state.loadedPlan.name} onStartNew={() => edit({ type: "reset" })} />
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <div className="min-w-0">
          <CatalogExplorer targetId={targetId} selection={selection} />
        </div>
        {canEdit && readyCatalog !== null ? (
          <PlanOptions
            state={state}
            dispatch={edit}
            roles={readyCatalog.roles}
            interfaces={readyCatalog.interfaces}
            budgetPlaceholders={budgetPlaceholders}
            budgetErrors={resolution.errors}
            serverErrors={serverErrors}
            productionTarget={productionTarget}
          />
        ) : null}
      </div>
      {canEdit && readyCatalog !== null ? (
        <PlanSummaryBar
          selectedCount={selectedCount}
          preview={preview}
          onClearSelection={() => edit({ type: "clear_selection" })}
          actions={actions}
          notice={notice}
        />
      ) : null}
      <PlanNameDialog
        open={saveOpen}
        onOpenChange={changeSaveDialog}
        title="Save plan"
        description="Keeps this selection and its options so you can run it again. Whether to reset the seed is chosen for each run."
        submitLabel="Save plan"
        pendingLabel="Saving"
        initialName={state.loadedPlan?.name ?? ""}
        isPending={savePlan.isPending}
        error={savePlan.error}
        onSubmit={saveAs}
      />
    </div>
  );
}
