"use client";

import { useEffect, useReducer, useRef } from "react";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { describeApiError } from "@/lib/api/errors";
import { ScheduleList } from "@/features/schedules/components/schedule-list";
import { CurrentTargetGate } from "@/features/targets/current-target-gate";
import { useUrlFilters } from "@/lib/url-state";
import { useLoadPlan } from "../mutations";
import {
  DEFAULT_WORKSPACE_TAB,
  isWorkspaceTab,
  PLAN_PARAM,
  requestedPlanCodec,
  workspaceTabCodec,
  type WorkspaceTab,
} from "../schemas";
import { createInitialBuilderState, planBuilderReducer } from "../selection-reducer";
import { useRequestedBundleId } from "../use-requested-bundle-id";
import { PlanBuilder } from "./plan-builder";
import { SavedPlansTab } from "./saved-plans-tab";

function PlanWorkspaceForTarget({ targetId }: { targetId: string }) {
  const [state, dispatch] = useReducer(planBuilderReducer, undefined, createInitialBuilderState);
  const bundleId = useRequestedBundleId();
  const { values, setFilters } = useUrlFilters(workspaceTabCodec);
  const tab = values.tab ?? DEFAULT_WORKSPACE_TAB;
  const requested = useUrlFilters(requestedPlanCodec);
  const requestedPlanId = requested.values[PLAN_PARAM] ?? null;
  const loadPlan = useLoadPlan({ targetId, bundleId });
  const handledPlanId = useRef<string | null>(null);

  useEffect(() => {
    if (requestedPlanId === null) {
      handledPlanId.current = null;
      return;
    }
    if (handledPlanId.current === requestedPlanId) {
      return;
    }
    handledPlanId.current = requestedPlanId;
    loadPlan.mutate(requestedPlanId, {
      onSuccess: ({ plan, catalog }) => {
        if (plan.target_id !== targetId) {
          toast.error("That plan belongs to another target");
        } else {
          dispatch({ type: "load_plan", plan, catalog });
          toast.success(`Loaded "${plan.name ?? "Untitled plan"}" into the builder`);
        }
        requested.setFilters({ [PLAN_PARAM]: undefined });
      },
      onError: (error) => {
        toast.error("Could not load the plan", { description: describeApiError(error) });
        requested.setFilters({ [PLAN_PARAM]: undefined });
      },
    });
  }, [requestedPlanId, loadPlan, requested, targetId]);

  function showTab(next: WorkspaceTab): void {
    setFilters({ tab: next === DEFAULT_WORKSPACE_TAB ? undefined : next }, { history: "push" });
  }

  return (
    <Tabs
      value={tab}
      onValueChange={(next) => {
        if (isWorkspaceTab(next)) {
          showTab(next);
        }
      }}
      data-slot="plan-workspace"
      className="gap-4"
    >
      <TabsList aria-label="Catalog views">
        <TabsTrigger value="catalog">Catalog</TabsTrigger>
        <TabsTrigger value="plans">Saved plans</TabsTrigger>
      </TabsList>
      <TabsContent value="catalog">
        <PlanBuilder
          targetId={targetId}
          state={state}
          dispatch={dispatch}
          onOpenSavedPlans={() => showTab("plans")}
        />
      </TabsContent>
      <TabsContent value="plans" className="flex flex-col gap-8">
        <SavedPlansTab
          targetId={targetId}
          bundleId={bundleId}
          dispatch={dispatch}
          onShowCatalog={() => showTab("catalog")}
        />
        <ScheduleList targetId={targetId} />
      </TabsContent>
    </Tabs>
  );
}

export function PlanWorkspace() {
  return (
    <CurrentTargetGate
      title="Choose a target"
      description="Plans are built from one target's latest valid bundle. Pick a target to browse its features and run them."
    >
      {(targetId) => <PlanWorkspaceForTarget key={targetId} targetId={targetId} />}
    </CurrentTargetGate>
  );
}
