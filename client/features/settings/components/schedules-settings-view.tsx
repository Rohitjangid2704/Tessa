"use client";

import { useQuery } from "@tanstack/react-query";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Skeleton } from "@/components/ui/skeleton";
import { ScheduleList } from "@/features/schedules/components/schedule-list";
import { describeApiError } from "@/lib/api/errors";
import { useCanDo } from "@/lib/auth/can";
import { useHydrated } from "@/lib/use-hydrated";
import { settingsQuery } from "../queries";
import { DirtySectionsProvider, UnsavedChangesGuard } from "../unsaved-changes";
import { PoliciesForm } from "./policies-form";

function PoliciesSkeleton() {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading the flakiness policy</span>
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

function PoliciesSection() {
  const hydrated = useHydrated();
  const settings = useQuery(settingsQuery());
  const { allowed: canWrite, isPending: rolePending } = useCanDo("settings.write");

  if (!hydrated || settings.isPending || rolePending) {
    return <PoliciesSkeleton />;
  }
  if (settings.isError) {
    return (
      <ErrorState
        title="Could not load the flakiness policy"
        description={describeApiError(settings.error)}
        requestId={readRequestId(settings.error)}
        retryLabel={settings.isFetching ? "Retrying" : "Retry"}
        onRetry={() => void settings.refetch()}
      />
    );
  }
  return <PoliciesForm settings={settings.data} readOnly={!canWrite} />;
}

export function SchedulesSettingsView() {
  return (
    <DirtySectionsProvider>
      <UnsavedChangesGuard />
      <div className="flex flex-col gap-8">
        <ScheduleList targetId={null} />
        <PoliciesSection />
      </div>
    </DirtySectionsProvider>
  );
}
