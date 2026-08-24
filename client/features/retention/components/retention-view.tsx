"use client";

import { useQuery } from "@tanstack/react-query";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { PermissionDenied } from "@/components/permission-denied";
import { Skeleton } from "@/components/ui/skeleton";
import { DirtySectionsProvider, UnsavedChangesGuard } from "@/features/settings/unsaved-changes";
import { describeApiError, isApiError } from "@/lib/api/errors";
import { useHydrated } from "@/lib/use-hydrated";
import { retentionQuery } from "../queries";
import { LastSweepCard } from "./last-sweep-card";
import { RetentionForm } from "./retention-form";

const SKELETON_SECTIONS = 2;

function RetentionSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading the retention policy</span>
      {Array.from({ length: SKELETON_SECTIONS }, (_, index) => (
        <Skeleton key={index} className="h-48 w-full" />
      ))}
    </div>
  );
}

export function RetentionView() {
  const hydrated = useHydrated();
  const retention = useQuery(retentionQuery());

  if (!hydrated || retention.isPending) {
    return <RetentionSkeleton />;
  }

  const { data } = retention;
  if (data === undefined) {
    if (isApiError(retention.error) && retention.error.status === 403) {
      return <PermissionDenied action="retention.write" />;
    }
    return (
      <ErrorState
        title="Could not load the retention policy"
        description={describeApiError(retention.error)}
        requestId={readRequestId(retention.error)}
        retryLabel={retention.isFetching ? "Retrying" : "Retry"}
        onRetry={() => void retention.refetch()}
      />
    );
  }

  return (
    <DirtySectionsProvider>
      <UnsavedChangesGuard />
      <div className="flex flex-col gap-4" data-slot="retention-view">
        <RetentionForm policy={data.policy} />
        <LastSweepCard sweep={data.last_sweep} />
      </div>
    </DirtySectionsProvider>
  );
}
