"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Bookmark, TriangleAlert } from "lucide-react";
import type { Dispatch } from "react";
import { toast } from "sonner";
import { DataTableFooter } from "@/components/data-table";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import { useCan } from "@/lib/auth/can";
import { useHydrated } from "@/lib/use-hydrated";
import { useLoadPlan } from "../mutations";
import { savedPlansQuery } from "../queries";
import type { PlanBuilderAction } from "../selection-reducer";
import { SavedPlanCard } from "./saved-plan-card";

export interface SavedPlansTabProps {
  targetId: string;
  bundleId: string | null;
  dispatch: Dispatch<PlanBuilderAction>;
  onShowCatalog: () => void;
}

const SKELETON_CARDS = 3;

function SavedPlansSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-3">
      <span className="sr-only">Loading saved plans</span>
      {Array.from({ length: SKELETON_CARDS }, (_, index) => (
        <Skeleton key={index} aria-hidden="true" className="h-32 w-full rounded-xl" />
      ))}
    </div>
  );
}

export function SavedPlansTab({ targetId, bundleId, dispatch, onShowCatalog }: SavedPlansTabProps) {
  const hydrated = useHydrated();
  const canEdit = useCan("plans.save");
  const query = useInfiniteQuery(savedPlansQuery(targetId));
  const load = useLoadPlan({ targetId, bundleId });
  const loadRequestId = readRequestId(load.error);
  const loadingPlanId = load.isPending ? load.variables : null;

  function loadPlan(planId: string): void {
    load.mutate(planId, {
      onSuccess: ({ plan, catalog }) => {
        dispatch({ type: "load_plan", plan, catalog });
        toast.success(`Loaded "${plan.name ?? "Untitled plan"}" into the builder`);
        onShowCatalog();
      },
    });
  }

  if (!hydrated || query.isPending) {
    return <SavedPlansSkeleton />;
  }

  if (query.isError) {
    return (
      <ErrorState
        title="Could not load the saved plans"
        description={describeApiError(query.error)}
        requestId={readRequestId(query.error)}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const plans = query.data.items;
  if (plans.length === 0) {
    return (
      <EmptyState
        title="No saved plans yet"
        description={
          canEdit
            ? "Tick features in the Catalog tab, then use Save plan to keep the selection and its options for later."
            : "Members can save a selection from the Catalog tab. Saved plans of this target will be listed here."
        }
        icon={Bookmark}
        action={
          <Button type="button" variant="outline" onClick={onShowCatalog}>
            Open the catalog
          </Button>
        }
      />
    );
  }

  return (
    <div data-slot="saved-plans" className="flex flex-col gap-4">
      {load.error === null ? null : (
        <Alert variant="destructive" data-slot="load-plan-alert">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription>
            <p>Could not load the plan into the builder. {describeApiError(load.error)}</p>
            {loadRequestId === null ? null : (
              <p className="font-mono text-xs">Request ID: {loadRequestId}</p>
            )}
          </AlertDescription>
        </Alert>
      )}
      <ul aria-label="Saved plans" className="flex flex-col gap-3">
        {plans.map((plan) => (
          <li key={plan.id}>
            <SavedPlanCard
              plan={plan}
              isLoading={loadingPlanId === plan.id}
              loadDisabled={load.isPending}
              onLoad={loadPlan}
            />
          </li>
        ))}
      </ul>
      <DataTableFooter
        noun="plan"
        loadedCount={query.data.loadedCount}
        total={query.data.total}
        hasNextPage={query.hasNextPage}
        isFetchingNextPage={query.isFetchingNextPage}
        onLoadMore={() => void query.fetchNextPage()}
      />
    </div>
  );
}
