"use client";

import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Hourglass, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { CopyButton } from "@/components/copy-button";
import { DateTime } from "@/components/date-time";
import { BudgetMeter } from "@/components/status/budget-meter";
import { RunStatusBadge } from "@/components/status/run-status-badge";
import { RunTriggerBadge } from "@/components/status/run-trigger";
import { StatusBadge } from "@/components/status/status-badge";
import { VerdictBar } from "@/components/status/verdict-bar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { targetQuery } from "@/features/targets/queries";
import type { Run } from "@/lib/api/types";
import { runGroupRoutes, targetRoutes } from "@/lib/routes";
import { safeHttpUrl } from "@/lib/safe-http-url";
import { CancelRunButton } from "./components/cancel-run-button";
import { RunBanners } from "./components/run-banners";
import { RunConfigSnapshot } from "./components/run-config-snapshot";
import { RunLiveIndicator } from "./components/run-live-indicator";
import { RunReportMenu } from "./components/run-report-menu";
import { RunSubsetBadge } from "./components/run-subset-badge";
import { RunStatusAnnouncer } from "./components/run-status-announcer";
import { isStopRequested, StopRunButton } from "./components/stop-run-button";
import { RUN_KIND_LABELS } from "./labels";
import { isCancelableRunStatus, shortRunId } from "./run-status";
import { useRunStreamState } from "./use-run-stream";

function kindTitle(kind: Run["kind"]): string {
  return `${RUN_KIND_LABELS[kind]} run`;
}

function StoppingChip() {
  return (
    <StatusBadge
      tone="live-reconnecting"
      label="Stopping"
      icon={Hourglass}
      data-slot="stopping-chip"
      title="Stop requested: the run ends after the current step and pending candidates are verified"
    />
  );
}

function ReadOnlyChip() {
  return (
    <StatusBadge
      tone="hollow"
      label="Read-only"
      icon={ShieldAlert}
      data-slot="read-only-chip"
      title="Production target: write features are skipped in this run"
    />
  );
}

function AssertingSeedNote() {
  return (
    <span data-slot="asserting-seed" className="text-sm font-medium text-muted-foreground">
      Asserting seed
    </span>
  );
}

function TargetLink({ targetId }: { targetId: string | null }) {
  const target = useQuery({ ...targetQuery(targetId ?? ""), enabled: targetId !== null });
  if (targetId === null) {
    return null;
  }
  return (
    <span>
      Target{" "}
      <Link
        href={targetRoutes.detail(targetId)}
        className="font-medium text-foreground underline-offset-4 hover:underline"
      >
        {target.data?.name ?? "details"}
      </Link>
    </span>
  );
}

function TemporalLink({ url }: { url: string | null }) {
  const href = safeHttpUrl(url);
  if (href === null) {
    return null;
  }
  return (
    <Button asChild variant="outline" size="sm">
      <a href={href} target="_blank" rel="noopener noreferrer">
        Open in Temporal
        <ExternalLink aria-hidden="true" data-icon="inline-end" />
        <span className="sr-only">(opens in a new tab)</span>
      </a>
    </Button>
  );
}

function RunMeta({ run }: { run: Run }) {
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
      <TargetLink targetId={run.target_id} />
      {run.run_group_id === null ? null : (
        <span>
          Part of{" "}
          <Link
            href={runGroupRoutes.detail(run.run_group_id)}
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            a run group
          </Link>
        </span>
      )}
      <span>
        Created <DateTime value={run.created_at} />
      </span>
      <span>
        Started <DateTime value={run.started_at} fallback="not yet" />
      </span>
      {run.finished_at === null ? null : (
        <span>
          Finished <DateTime value={run.finished_at} />
        </span>
      )}
      <span className="inline-flex items-center gap-1">
        <code className="font-mono text-xs">{run.id}</code>
        <CopyButton text={run.id} subject="run id" variant="ghost" size="xs" />
      </span>
    </p>
  );
}

export function RunHeaderSkeleton() {
  return (
    <header role="status" aria-busy="true" className="flex flex-col gap-3">
      <span className="sr-only">Loading the run</span>
      <Skeleton className="h-8 w-72 max-w-full" />
      <Skeleton className="h-4 w-96 max-w-full" />
      <Skeleton className="h-5 w-80 max-w-full" />
    </header>
  );
}

export function RunHeader() {
  const { run } = useRunStreamState();
  if (run === undefined) {
    return <RunHeaderSkeleton />;
  }
  return (
    <header data-slot="run-header" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {kindTitle(run.kind)} <span className="font-mono text-xl">{shortRunId(run.id)}</span>
        </h1>
        <RunStatusBadge status={run.status} />
        {run.kind === "suite" && run.status === "seeding" ? <AssertingSeedNote /> : null}
        {run.read_only ? <ReadOnlyChip /> : null}
        {run.trigger === "manual" ? null : <RunTriggerBadge trigger={run.trigger} />}
        <RunSubsetBadge run={run} />
        {isStopRequested(run) && isCancelableRunStatus(run.status) ? <StoppingChip /> : null}
        <RunLiveIndicator />
        <div className="ml-auto flex flex-wrap items-start justify-end gap-2">
          <TemporalLink url={run.temporal_ui_url} />
          <RunConfigSnapshot run={run} />
          <RunReportMenu run={run} />
          <StopRunButton run={run} />
          <CancelRunButton run={run} />
        </div>
      </div>
      <RunMeta run={run} />
      {run.kind === "seed" ? null : (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <VerdictBar counters={run.counters} showProgress />
          <BudgetMeter budget={run.budget} />
        </div>
      )}
      <RunBanners />
      <RunStatusAnnouncer />
    </header>
  );
}
