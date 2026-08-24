"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useId, type ReactNode } from "react";
import { toast } from "sonner";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import type { Schedule, ScheduleCreate } from "@/lib/api/types";
import { toScheduleUpdate } from "../form-model";
import { useCreateSchedule, useUpdateSchedule } from "../mutations";
import { schedulePlansQuery, scheduleSchemaQuery, schedulesQuery } from "../queries";
import { ScheduleForm } from "./schedule-form";
import { UNTITLED_PLAN } from "./schedule-form-parts";

export interface ScheduleFormDialogProps {
  schedule: Schedule | null;
  targetId: string | null;
  onClose: () => void;
}

function FormSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-3">
      <span className="sr-only">Loading the schedule form</span>
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-9 w-full" />
    </div>
  );
}

export function ScheduleFormDialog({ schedule, targetId, onClose }: ScheduleFormDialogProps) {
  const formId = useId();
  const schema = useQuery(scheduleSchemaQuery());
  const plans = useInfiniteQuery(schedulePlansQuery(targetId));
  const schedules = useInfiniteQuery(schedulesQuery());
  const create = useCreateSchedule();
  const update = useUpdateSchedule();
  const isSaving = create.isPending || update.isPending;
  const title = schedule === null ? "New schedule" : "Edit schedule";

  function submit(body: ScheduleCreate, onFailure: (error: unknown) => void): void {
    if (schedule === null) {
      create.create(body, {
        onSuccess: (created) => {
          toast.success(
            created.tier === "commit"
              ? "Commit schedule created. Call run-now from CI to start it."
              : "Schedule created",
          );
          onClose();
        },
        onError: onFailure,
      });
      return;
    }
    update.mutate(
      { scheduleId: schedule.id, update: toScheduleUpdate(body) },
      {
        onSuccess: () => {
          toast.success("Schedule updated");
          onClose();
        },
        onError: onFailure,
      },
    );
  }

  let body: ReactNode;
  let ready = false;
  if (schema.isPending || plans.isPending || schedules.isPending) {
    body = <FormSkeleton />;
  } else if (schema.isError || plans.isError || schedules.isError) {
    const failed = schema.error ?? plans.error ?? schedules.error;
    body = (
      <ErrorState
        title="Could not load the schedule form"
        description={describeApiError(failed)}
        requestId={readRequestId(failed)}
        onRetry={() => {
          void schema.refetch();
          void plans.refetch();
          void schedules.refetch();
        }}
      />
    );
  } else {
    const scheduledPlanIds = new Set(schedules.data.items.map((row) => row.plan_id));
    const savedPlans = plans.data.items;
    const selectable = savedPlans.filter(
      (plan) => plan.schedule_id === null && !scheduledPlanIds.has(plan.id),
    );
    const ownPlan =
      schedule === null ? undefined : savedPlans.find((plan) => plan.id === schedule.plan_id);
    ready = schedule !== null || selectable.length > 0;
    body = (
      <ScheduleForm
        formId={formId}
        schedule={schedule}
        plans={selectable}
        planName={ownPlan === undefined ? null : (ownPlan.name ?? UNTITLED_PLAN)}
        schemas={schema.data}
        isSaving={isSaving}
        onSubmit={submit}
      />
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            A schedule runs one saved plan on a clock or from CI and tells people how it went.
          </DialogDescription>
        </DialogHeader>
        {body}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={!ready || isSaving}>
            {isSaving ? "Saving" : schedule === null ? "Create schedule" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
