"use client";

import { useQuery } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { DateTime } from "@/components/date-time";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { RunStatusBadge } from "@/components/status/run-status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { isTerminalRunStatus } from "@/features/runs/run-status";
import { describeApiError, isApiError } from "@/lib/api/errors";
import type { Replay, ReplayProgressPayload } from "@/lib/api/types";
import { replayRoutes, runRoutes } from "@/lib/routes";
import { useHydrated } from "@/lib/use-hydrated";
import { replayQuery } from "../queries";
import { ReplayRecords } from "./replay-records";

const PERCENT = 100;
const NOT_FOUND_STATUSES: readonly number[] = [404, 422];

export type ReplayCounts = {
  total: number;
  created: number;
  rejected: number;
  pending: number;
  percentRead: number;
};

export function countReplay(
  replay: Replay,
  live: ReplayProgressPayload | null = null,
): ReplayCounts {
  const sameReplay = live !== null && live.replay_id === replay.id;
  const total = sameReplay ? Math.max(replay.records_total, live.records_total) : replay.records_total;
  const created = sameReplay ? Math.max(replay.cases_created, live.cases_created) : replay.cases_created;
  const rejected = sameReplay
    ? Math.max(replay.cases_rejected, live.cases_rejected)
    : replay.cases_rejected;
  const read = created + rejected;
  return {
    total,
    created,
    rejected,
    pending: Math.max(0, total - read),
    percentRead: total === 0 ? PERCENT : Math.min(PERCENT, Math.round((read / total) * PERCENT)),
  };
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

export type ReplayDetailProps = {
  replayId: string;
  live?: ReplayProgressPayload | null;
};

export function ReplayDetail({ replayId, live = null }: ReplayDetailProps) {
  const headingId = useId();
  const hydrated = useHydrated();
  const query = useQuery(replayQuery(replayId));

  if (!hydrated || query.isPending) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-3">
        <span className="sr-only">Loading the replay</span>
        <Skeleton className="h-7 w-72 max-w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (query.isError) {
    const missing = isApiError(query.error) && NOT_FOUND_STATUSES.includes(query.error.status);
    return (
      <ErrorState
        title={missing ? "Replay not found" : "Could not load the replay"}
        description={
          missing
            ? "This replay does not exist or was removed. Pick another one from the list."
            : describeApiError(query.error)
        }
        requestId={readRequestId(query.error)}
        onRetry={missing ? undefined : () => void query.refetch()}
        action={
          <Button asChild variant="outline">
            <Link href={replayRoutes.list()}>Back to the replays</Link>
          </Button>
        }
      />
    );
  }

  const replay = query.data;
  const counts = countReplay(replay, live);
  const active = !isTerminalRunStatus(replay.status);
  const zeroCases = !active && counts.created === 0;

  return (
    <section
      aria-labelledby={headingId}
      data-slot="replay-detail"
      data-replay-id={replay.id}
      data-status={replay.status}
      className="flex flex-col gap-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 id={headingId} className="text-base font-semibold break-all">
            {replay.source_name}
          </h2>
          <RunStatusBadge status={replay.status} />
          <span className="text-sm text-muted-foreground">
            Uploaded <DateTime value={replay.created_at} />
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={runRoutes.detail(replay.run_id)}>Open the run</Link>
          </Button>
          {counts.created > 0 ? (
            <Button asChild size="sm">
              <Link href={replayRoutes.cases(replay.id)}>
                Review {counts.created} {counts.created === 1 ? "case" : "cases"}
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Replay counts">
        <Stat label="Records" value={counts.total} />
        <Stat label="Cases created" value={counts.created} />
        <Stat label="Rejected" value={counts.rejected} />
        <Stat label="Not read yet" value={counts.pending} />
      </dl>
      {active ? (
        <div data-slot="replay-progress" className="flex flex-col gap-1.5">
          <Progress
            value={counts.percentRead}
            aria-label="Records read"
            aria-valuetext={`${counts.percentRead} percent of the records read`}
          />
          <p role="status" className="text-sm text-muted-foreground">
            {counts.created + counts.rejected} of {counts.total} records read.
          </p>
        </div>
      ) : null}
      {zeroCases ? (
        <Alert data-slot="replay-zero-cases">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>No case was created from this export</AlertTitle>
          <AlertDescription>
            {counts.total === 0
              ? "The server did not read any record from this file. Check that it is a JSON lines export with one conversation per line."
              : "Every record was rejected. The reason for each one is listed below, so you can fix the export and upload it again."}
          </AlertDescription>
        </Alert>
      ) : null}
      <ReplayRecords replayId={replay.id} casesRejected={counts.rejected} active={active} />
    </section>
  );
}
