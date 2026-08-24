"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useId } from "react";
import { RunStatusBadge } from "@/components/status/run-status-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { RunKindList } from "@/features/runs/components/run-kind-list";
import { runQuery } from "@/features/runs/run-detail-queries";
import { isTerminalRunStatus, shortRunId } from "@/features/runs/run-status";
import { runsListQuery } from "@/features/runs/queries";
import { TargetTierBadge } from "@/features/targets/components/target-tier-badge";
import { CurrentTargetGate } from "@/features/targets/current-target-gate";
import { targetQuery } from "@/features/targets/queries";
import { polling } from "@/lib/api/polling";
import { runRoutes, targetRoutes } from "@/lib/routes";
import { useUrlFilters } from "@/lib/url-state";
import { useHydrated } from "@/lib/use-hydrated";
import { redteamPageCodec } from "../schemas";
import { RedteamForm } from "./redteam-form";
import { RedteamRunPanel } from "./redteam-run-panel";

type SelectedRunProps = {
  runId: string;
};

function SelectedRun({ runId }: SelectedRunProps) {
  const headingId = useId();
  const hydrated = useHydrated();
  const run = useQuery({ ...runQuery(runId), ...polling.run });
  const status = run.data?.status;
  const runActive = status !== undefined && !isTerminalRunStatus(status);

  return (
    <section aria-labelledby={headingId} data-slot="selected-redteam-run" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id={headingId} className="text-base font-semibold">
            Run <span className="font-mono text-sm">{shortRunId(runId)}</span>
          </h2>
          {hydrated && status !== undefined ? <RunStatusBadge status={status} /> : null}
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href={runRoutes.detail(runId)}>Open the live view</Link>
        </Button>
      </div>
      <RedteamRunPanel runId={runId} runActive={hydrated && runActive} />
    </section>
  );
}

type RedteamWorkspaceProps = {
  targetId: string;
};

export function RedteamWorkspace({ targetId }: RedteamWorkspaceProps) {
  const startHeadingId = useId();
  const hydrated = useHydrated();
  const target = useQuery(targetQuery(targetId));
  const selection = useUrlFilters(redteamPageCodec);
  const runs = useInfiniteQuery(runsListQuery({ target_id: targetId, kind: ["redteam"] }));
  const selectedRunId = selection.values.run_id ?? runs.data?.items[0]?.id;

  return (
    <div data-slot="redteam-workspace" className="flex min-w-0 flex-col gap-8">
      <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>Target</span>
        {target.data === undefined ? (
          <Skeleton className="h-4 w-24" />
        ) : (
          <>
            <Link
              href={targetRoutes.detail(targetId)}
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              {target.data.name}
            </Link>
            <TargetTierBadge tier={target.data.tier} />
          </>
        )}
      </p>
      <section aria-labelledby={startHeadingId} className="flex flex-col gap-3">
        <h2 id={startHeadingId} className="text-base font-semibold">
          Start a red team run
        </h2>
        <RedteamForm targetId={targetId} />
      </section>
      <RunKindList
        kind="redteam"
        targetId={targetId}
        heading="Red team runs"
        noun="red team run"
        emptyDescription="Start a run above. Each round attacks with one family and a skeptic model checks every breach before it reaches the board."
      />
      {hydrated && selectedRunId !== undefined ? (
        <SelectedRun key={selectedRunId} runId={selectedRunId} />
      ) : null}
    </div>
  );
}

export function RedteamPage() {
  return (
    <CurrentTargetGate
      title="Choose a target"
      description="A red team run attacks one target with a chosen role. Pick a QA target to start one or to read earlier runs."
    >
      {(targetId) => <RedteamWorkspace key={targetId} targetId={targetId} />}
    </CurrentTargetGate>
  );
}
