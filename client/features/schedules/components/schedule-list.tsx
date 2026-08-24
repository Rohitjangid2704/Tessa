"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { CalendarClock, Plus } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { DataTableFooter } from "@/components/data-table";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import type { Schedule } from "@/lib/api/types";
import { useCanDo } from "@/lib/auth/can";
import { useHydrated } from "@/lib/use-hydrated";
import { schedulePlansQuery, schedulesQuery } from "../queries";
import { ScheduleCard } from "./schedule-card";
import { ScheduleFormDialog } from "./schedule-form-dialog";

export interface ScheduleListProps {
  targetId: string | null;
}

interface EditingState {
  schedule: Schedule | null;
}

const SKELETON_CARDS = 2;

function ScheduleListSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-3">
      <span className="sr-only">Loading schedules</span>
      {Array.from({ length: SKELETON_CARDS }, (_, index) => (
        <Skeleton key={index} aria-hidden="true" className="h-40 w-full rounded-xl" />
      ))}
    </div>
  );
}

export function ScheduleList({ targetId }: ScheduleListProps) {
  const headingId = useId();
  const hydrated = useHydrated();
  const { allowed: canEdit, isPending: rolePending } = useCanDo("schedules.write");
  const schedules = useInfiniteQuery(schedulesQuery());
  const plans = useInfiniteQuery(schedulePlansQuery(targetId));
  const [editing, setEditing] = useState<EditingState | null>(null);

  const description =
    targetId === null
      ? "Every schedule across your targets. A schedule runs one saved plan on a clock or from CI and tells people how it went."
      : "A schedule runs one saved plan of this target on a clock or from CI and tells people how it went.";

  let content: ReactNode;
  if (!hydrated || schedules.isPending || plans.isPending) {
    content = <ScheduleListSkeleton />;
  } else if (schedules.isError || plans.isError) {
    const failed = schedules.error ?? plans.error;
    content = (
      <ErrorState
        title="Could not load the schedules"
        description={describeApiError(failed)}
        requestId={readRequestId(failed)}
        onRetry={() => {
          void schedules.refetch();
          void plans.refetch();
        }}
      />
    );
  } else {
    const plansById = new Map(plans.data.items.map((plan) => [plan.id, plan]));
    const rows = schedules.data.items.filter(
      (schedule) => targetId === null || plansById.has(schedule.plan_id),
    );
    content =
      rows.length === 0 ? (
        <EmptyState
          title="No schedules yet"
          description={
            canEdit
              ? "Create a nightly or weekly schedule for a saved plan, or a commit schedule that CI starts through run-now."
              : "Members can create schedules. Schedules of this workspace will be listed here."
          }
          icon={CalendarClock}
          action={
            canEdit ? (
              <Button type="button" variant="outline" onClick={() => setEditing({ schedule: null })}>
                <Plus aria-hidden="true" data-icon="inline-start" />
                New schedule
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          <ul aria-label="Schedules" className="flex flex-col gap-3">
            {rows.map((schedule) => (
              <li key={schedule.id}>
                <ScheduleCard
                  schedule={schedule}
                  plan={plansById.get(schedule.plan_id) ?? null}
                  onEdit={(selected) => setEditing({ schedule: selected })}
                />
              </li>
            ))}
          </ul>
          <DataTableFooter
            noun="schedule"
            loadedCount={rows.length}
            total={targetId === null ? schedules.data.total : null}
            hasNextPage={schedules.hasNextPage}
            isFetchingNextPage={schedules.isFetchingNextPage}
            onLoadMore={() => void schedules.fetchNextPage()}
          />
        </div>
      );
  }

  return (
    <section
      data-slot="schedules"
      aria-labelledby={headingId}
      className="flex flex-col gap-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={headingId} className="text-lg font-semibold tracking-tight">
            Schedules
          </h2>
          <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
        </div>
        {canEdit ? (
          <Button type="button" onClick={() => setEditing({ schedule: null })}>
            <Plus aria-hidden="true" data-icon="inline-start" />
            New schedule
          </Button>
        ) : null}
      </div>
      {hydrated && !rolePending && !canEdit ? (
        <p data-slot="read-only-notice" className="text-sm text-muted-foreground">
          You have read-only access. Members can create, edit and run schedules.
        </p>
      ) : null}
      {content}
      {editing === null ? null : (
        <ScheduleFormDialog
          key={editing.schedule?.id ?? "new"}
          schedule={editing.schedule}
          targetId={targetId}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}
