"use client";

import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Flag, Play, RefreshCw, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { DataTableFooter } from "@/components/data-table";
import { CopyButton } from "@/components/copy-button";
import { DateTime } from "@/components/date-time";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { RunStatusBadge } from "@/components/status/run-status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { KnownStreamEvent } from "@/features/streams/events";
import { describeApiError } from "@/lib/api/errors";
import type { RunGroup, RunSummary } from "@/lib/api/types";
import { useCanDo } from "@/lib/auth/can";
import { runRoutes } from "@/lib/routes";
import { qk } from "@/lib/api/query-keys";
import { useHydrated } from "@/lib/use-hydrated";
import { RUN_STATUS_LABELS } from "../labels";
import { runsListQuery } from "../queries";
import { isTerminalRunStatus } from "../run-status";
import {
  isRunGroupNotFound,
  RUN_GROUP_MEMBERS_PAGE_SIZE,
  runGroupQuery,
} from "../run-groups/queries";
import { RunGroupDialog } from "./run-group-dialog";
import { RunsFeed } from "./runs-feed";
import { RunsTable } from "./runs-table";

const NO_FILTERS = {} as const;
const NO_MEMBERS: readonly RunSummary[] = [];

export type RunGroupPanelProps = {
  runGroupId: string;
};

export type MemberTally = {
  total: number;
  finished: number;
  failed: number;
  budgetExceeded: number;
  canceled: number;
  scenariosFailed: number;
  scenariosFlaky: number;
};

export function tallyMembers(members: readonly RunSummary[]): MemberTally {
  return members.reduce<MemberTally>(
    (tally, run) => ({
      total: tally.total + 1,
      finished: tally.finished + (isTerminalRunStatus(run.status) ? 1 : 0),
      failed: tally.failed + (run.status === "failed" ? 1 : 0),
      budgetExceeded: tally.budgetExceeded + (run.status === "budget_exceeded" ? 1 : 0),
      canceled: tally.canceled + (run.status === "canceled" ? 1 : 0),
      scenariosFailed: tally.scenariosFailed + run.counters.fail,
      scenariosFlaky: tally.scenariosFlaky + run.counters.flaky,
    }),
    {
      total: 0,
      finished: 0,
      failed: 0,
      budgetExceeded: 0,
      canceled: 0,
      scenariosFailed: 0,
      scenariosFlaky: 0,
    },
  );
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function describeRunProblems(tally: MemberTally): string[] {
  const lines: string[] = [];
  if (tally.failed > 0) {
    lines.push(`${plural(tally.failed, "run")} failed before finishing`);
  }
  if (tally.budgetExceeded > 0) {
    lines.push(`${plural(tally.budgetExceeded, "run")} ran out of budget`);
  }
  if (tally.canceled > 0) {
    lines.push(`${plural(tally.canceled, "run")} canceled`);
  }
  return lines;
}

function RunGroupLoading() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-6">
      <span className="sr-only">Loading the run group</span>
      <Skeleton className="h-28 w-full rounded-xl" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function BackToRuns() {
  return (
    <Button asChild variant="outline">
      <Link href={runRoutes.list()}>Back to runs</Link>
    </Button>
  );
}

function GroupOutcome({ group, tally }: { group: RunGroup; tally: MemberTally }) {
  const total = group.run_ids.length;
  if (!isTerminalRunStatus(group.status)) {
    return (
      <p role="status" data-slot="group-progress" className="text-sm text-muted-foreground">
        {tally.finished} of {total} runs finished. This page updates as they progress.
      </p>
    );
  }
  const problems = describeRunProblems(tally);
  if (problems.length > 0) {
    return (
      <Alert variant="destructive" data-slot="group-failures">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>The group finished with problems</AlertTitle>
        <AlertDescription>
          <ul className="list-disc pl-5">
            {problems.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {tally.scenariosFailed > 0 ? (
            <p>{plural(tally.scenariosFailed, "scenario")} failed across the runs.</p>
          ) : null}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <p data-slot="group-done" className="flex items-center gap-2 text-sm">
      <Flag aria-hidden="true" className="size-4 text-muted-foreground" />
      <span>
        All {plural(total, "run")} finished.
        {tally.scenariosFailed > 0
          ? ` ${plural(tally.scenariosFailed, "scenario")} failed across the runs; open a run to see which.`
          : " No scenario failed."}
      </span>
    </p>
  );
}

export function RunGroupPanel({ runGroupId }: RunGroupPanelProps) {
  const hydrated = useHydrated();
  const queryClient = useQueryClient();
  const { allowed: canStart, isPending: rolePending } = useCanDo("runs.start_group");
  const [feedGeneration, setFeedGeneration] = useState(0);
  const [rerunOpen, setRerunOpen] = useState(false);
  const group = useQuery(runGroupQuery(runGroupId));
  const members = useInfiniteQuery({
    ...runsListQuery({ run_group_id: runGroupId }, RUN_GROUP_MEMBERS_PAGE_SIZE),
    enabled: group.isSuccess,
  });

  const memberRuns = members.data?.items ?? NO_MEMBERS;
  const memberIds = new Set([...(group.data?.run_ids ?? []), ...memberRuns.map((run) => run.id)]);

  function handleFeedEvent(event: KnownStreamEvent): void {
    const runId = event.run_id;
    if (runId === null || !memberIds.has(runId)) {
      return;
    }
    if (
      event.type === "run.created" ||
      event.type === "run.status_changed" ||
      event.type === "run.finished"
    ) {
      void queryClient.invalidateQueries({ queryKey: qk.runGroups.detail(runGroupId) });
    }
  }

  if (!hydrated || group.isPending) {
    return <RunGroupLoading />;
  }
  if (group.data === undefined) {
    if (isRunGroupNotFound(group.error)) {
      return (
        <ErrorState
          title="Run group not found"
          description="This run group does not exist or was removed. Open the runs list to find your runs."
          requestId={readRequestId(group.error)}
          action={<BackToRuns />}
        />
      );
    }
    return (
      <ErrorState
        title="Could not load the run group"
        description={describeApiError(group.error)}
        requestId={readRequestId(group.error)}
        onRetry={() => void group.refetch()}
        action={<BackToRuns />}
      />
    );
  }

  const data = group.data;
  const tally = tallyMembers(memberRuns);
  const isLive = !isTerminalRunStatus(data.status);
  const isViewer = !rolePending && !canStart;
  const rerunTargets = [
    ...new Set(memberRuns.flatMap((run) => (run.target_id === null ? [] : [run.target_id]))),
  ];
  const rerunPlans = Object.fromEntries(
    memberRuns.flatMap((run): Array<[string, string]> =>
      run.target_id === null || run.plan_id === null ? [] : [[run.target_id, run.plan_id]],
    ),
  );

  return (
    <div data-slot="run-group-panel" data-status={data.status} className="flex flex-col gap-6">
      <section
        aria-labelledby="run-group-summary-heading"
        className="flex flex-col gap-3 rounded-xl border p-4"
      >
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="run-group-summary-heading" className="text-base font-semibold">
            Group status
          </h2>
          <RunStatusBadge status={data.status} />
          {isLive ? (
            <RunsFeed
              key={`${runGroupId}-${feedGeneration}`}
              filters={NO_FILTERS}
              onRestart={() => setFeedGeneration((generation) => generation + 1)}
              onEvent={handleFeedEvent}
            />
          ) : null}
        </div>
        <p role="status" className="sr-only">
          Run group status: {RUN_STATUS_LABELS[data.status]}
        </p>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          <div className="flex flex-col">
            <dt className="text-muted-foreground">Started</dt>
            <dd>
              <DateTime value={data.created_at} />
            </dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-muted-foreground">Runs</dt>
            <dd>{data.run_ids.length}</dd>
          </div>
          <div className="flex min-w-0 flex-col">
            <dt className="text-muted-foreground">Group id</dt>
            <dd className="flex items-center gap-2">
              <code className="truncate font-mono text-xs">{data.id}</code>
              <CopyButton text={data.id} subject="group id" variant="ghost" size="xs" />
            </dd>
          </div>
        </dl>
        <GroupOutcome group={data} tally={tally} />
        <div className="flex flex-wrap items-center gap-3">
          {canStart ? (
            <Button
              type="button"
              variant="outline"
              disabled={rerunTargets.length < 2}
              onClick={() => setRerunOpen(true)}
            >
              <RefreshCw aria-hidden="true" data-icon="inline-start" />
              Run these targets again
            </Button>
          ) : null}
          {isViewer ? (
            <p role="status" data-slot="viewer-note" className="text-sm text-muted-foreground">
              You can watch this group. Starting a run group needs the member or admin role.
            </p>
          ) : null}
        </div>
      </section>
      <section aria-labelledby="run-group-members-heading" className="flex flex-col gap-3">
        <h2 id="run-group-members-heading" className="text-base font-semibold">
          Member runs
        </h2>
        <RunsTable
          rows={members.data?.items}
          isLoading={members.isPending}
          isFetching={members.isFetching}
          error={members.error}
          onRetry={() => void members.refetch()}
          emptyState={
            <EmptyState
              title="No member runs listed yet"
              description="The runs of this group appear here as soon as they are created."
              icon={Play}
            />
          }
          footer={
            <DataTableFooter
              noun="run"
              loadedCount={members.data?.loadedCount ?? 0}
              total={members.data?.total}
              hasNextPage={members.hasNextPage}
              isFetchingNextPage={members.isFetchingNextPage}
              onLoadMore={() => void members.fetchNextPage()}
            />
          }
        />
      </section>
      {rerunOpen ? (
        <RunGroupDialog
          open
          targetIds={rerunTargets}
          initialPlanIds={rerunPlans}
          onOpenChange={setRerunOpen}
        />
      ) : null}
    </div>
  );
}
