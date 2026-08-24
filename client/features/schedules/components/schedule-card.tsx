"use client";

import { CalendarClock, Pause, Pencil, Play, Trash } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { formatUtc } from "@/components/date-time";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { readRequestId } from "@/components/states/request-id";
import type { Plan, Schedule } from "@/lib/api/types";
import { useCan } from "@/lib/auth/can";
import { formatUsd } from "@/lib/format-usd";
import { runRoutes } from "@/lib/routes";
import { describeCron } from "../cron";
import { describeActionFailure, describeRunNowFailure } from "../errors";
import { SCHEDULE_TIER_LABELS } from "../form-model";
import { useDeleteSchedule, useRunScheduleNow, useUpdateSchedule } from "../mutations";
import { formatInTimeZone } from "../time";
import { RunNowSnippet } from "./run-now-snippet";
import { UNTITLED_PLAN } from "./schedule-form-parts";

export interface ScheduleCardProps {
  schedule: Schedule;
  plan: Plan | null;
  onEdit: (schedule: Schedule) => void;
}

export const PLAN_NOT_FOUND = "Plan not found";

export function describeNotify(notify: Schedule["notify"]): string {
  const parts: string[] = [];
  if (notify.slack) {
    parts.push("Slack");
  }
  if (notify.email.length > 0) {
    parts.push(notify.email.length === 1 ? "1 email" : `${notify.email.length} emails`);
  }
  return parts.length === 0 ? "Nobody" : parts.join(" and ");
}

function describeBudget(budget: Schedule["budget"]): string {
  return budget === null
    ? "The budget of the plan"
    : `${formatUsd(budget.max_usd)} or ${budget.max_minutes} min`;
}

function NextRun({ schedule }: { schedule: Schedule }) {
  if (schedule.tier === "commit") {
    return <>Not on a clock, it starts when CI calls run-now</>;
  }
  if (!schedule.enabled) {
    return <>Paused</>;
  }
  const formatted = formatInTimeZone(schedule.next_run_at, schedule.timezone);
  if (formatted === null || schedule.next_run_at === null) {
    return <>Not scheduled</>;
  }
  return (
    <time
      dateTime={schedule.next_run_at}
      title={formatUtc(schedule.next_run_at) ?? undefined}
      suppressHydrationWarning
    >
      {formatted}
    </time>
  );
}

export function ScheduleCard({ schedule, plan, onEdit }: ScheduleCardProps) {
  const canWrite = useCan("schedules.write");
  const canRunNow = useCan("schedules.run_now");
  const headingId = useId();
  const enabledId = useId();
  const runNow = useRunScheduleNow(schedule.id);
  const update = useUpdateSchedule();
  const remove = useDeleteSchedule();
  const planName = plan === null ? PLAN_NOT_FOUND : (plan.name ?? UNTITLED_PLAN);
  const reading = schedule.cron === null ? null : describeCron(schedule.cron);
  const startedRunId = runNow.data?.run_id ?? null;
  const failures = [
    runNow.error === null ? null : describeRunNowFailure(runNow.error),
    update.error === null ? null : describeActionFailure("update", update.error),
    remove.error === null ? null : describeActionFailure("delete", remove.error),
  ].filter((text) => text !== null);
  const requestId = readRequestId(runNow.error ?? update.error ?? remove.error);

  return (
    <article
      data-slot="schedule"
      data-schedule-id={schedule.id}
      data-tier={schedule.tier}
      data-enabled={schedule.enabled ? "true" : "false"}
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h3 id={headingId} className="text-sm font-semibold wrap-break-word">
            {planName}
          </h3>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">
              <CalendarClock aria-hidden="true" />
              {SCHEDULE_TIER_LABELS[schedule.tier]}
            </Badge>
            <Badge variant="outline">
              {schedule.enabled ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
              {schedule.enabled ? "Enabled" : "Paused"}
            </Badge>
          </div>
        </div>
        {canWrite ? (
          <div className="flex items-center gap-2">
            <Switch
              id={enabledId}
              checked={schedule.enabled}
              disabled={update.isPending}
              onCheckedChange={(enabled) =>
                update.mutate({ scheduleId: schedule.id, update: { enabled } })
              }
            />
            <Label htmlFor={enabledId} className="font-normal">
              Enabled<span className="sr-only"> for {planName}</span>
            </Label>
          </div>
        ) : null}
      </div>
      <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Runs</dt>
        <dd>
          {schedule.cron === null ? (
            "From CI through run-now"
          ) : (
            <>
              {reading === null ? null : <span>{reading}. </span>}
              <code className="font-mono text-xs">{schedule.cron}</code>
            </>
          )}
        </dd>
        <dt className="text-muted-foreground">Time zone</dt>
        <dd>{schedule.timezone}</dd>
        <dt className="text-muted-foreground">Next run</dt>
        <dd data-slot="next-run">
          <NextRun schedule={schedule} />
        </dd>
        <dt className="text-muted-foreground">Last run</dt>
        <dd>
          {schedule.last_run_id === null ? (
            "No run yet"
          ) : (
            <Link
              href={runRoutes.detail(schedule.last_run_id)}
              className="underline underline-offset-3"
            >
              Open the last run
            </Link>
          )}
        </dd>
        <dt className="text-muted-foreground">Stops at</dt>
        <dd className="tabular-nums">{describeBudget(schedule.budget)}</dd>
        <dt className="text-muted-foreground">Tells</dt>
        <dd>{describeNotify(schedule.notify)}</dd>
      </dl>
      {schedule.tier === "commit" ? (
        <details data-slot="ci-command">
          <summary className="cursor-pointer text-sm font-medium">Show the CI command</summary>
          <div className="pt-2">
            <RunNowSnippet scheduleId={schedule.id} />
          </div>
        </details>
      ) : null}
      <div role="status" className={startedRunId === null ? "sr-only" : "text-sm"}>
        {startedRunId === null ? null : (
          <>
            Run started.{" "}
            <Link href={runRoutes.detail(startedRunId)} className="underline underline-offset-3">
              Open the run
            </Link>
          </>
        )}
      </div>
      {failures.length === 0 ? null : (
        <Alert variant="destructive" data-slot="schedule-action-alert">
          <AlertDescription>
            {failures.map((text) => (
              <p key={text}>{text}</p>
            ))}
            {requestId === null ? null : (
              <p className="font-mono text-xs">Request ID: {requestId}</p>
            )}
          </AlertDescription>
        </Alert>
      )}
      {canWrite || canRunNow ? (
        <div className="flex flex-wrap gap-2">
          {canRunNow ? (
            <Button
              type="button"
              size="sm"
              disabled={runNow.isPending}
              aria-busy={runNow.isPending}
              onClick={() => runNow.mutate()}
            >
              <Play aria-hidden="true" data-icon="inline-start" />
              {runNow.isPending ? "Starting" : "Run now"}
              <span className="sr-only"> {planName}</span>
            </Button>
          ) : null}
          {canWrite ? (
            <>
              <Button type="button" variant="outline" size="sm" onClick={() => onEdit(schedule)}>
                <Pencil aria-hidden="true" data-icon="inline-start" />
                Edit<span className="sr-only"> schedule of {planName}</span>
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button type="button" variant="outline" size="sm" disabled={remove.isPending}>
                    <Trash aria-hidden="true" data-icon="inline-start" />
                    {remove.isPending ? "Deleting" : "Delete"}
                    <span className="sr-only"> schedule of {planName}</span>
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete the schedule of {planName}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      The schedule stops firing and its Temporal schedule is removed. The plan and
                      the runs it already made stay.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep schedule</AlertDialogCancel>
                    <AlertDialogAction onClick={() => remove.mutate(schedule.id)}>
                      Delete schedule
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
