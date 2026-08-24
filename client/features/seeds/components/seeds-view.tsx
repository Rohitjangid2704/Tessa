"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TargetTierBadge } from "@/features/targets/components/target-tier-badge";
import { CurrentTargetGate } from "@/features/targets/current-target-gate";
import { isTargetNotFound, targetQuery } from "@/features/targets/queries";
import { describeApiError } from "@/lib/api/errors";
import { targetRoutes } from "@/lib/routes";
import { useUrlFilters } from "@/lib/url-state";
import { useHydrated } from "@/lib/use-hydrated";
import { seedsListQuery } from "../queries";
import { readId, seedSelectionCodec } from "../schemas";
import { useSeedRun } from "../use-seed-run";
import { NoSeedsState } from "./no-seeds-state";
import { SeedDetail } from "./seed-detail";
import { SeedVersions } from "./seed-versions";

function WorkspaceSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading the seed versions</span>
      <Skeleton className="h-6 w-64" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export interface SeedsWorkspaceProps {
  targetId: string;
}

export function SeedsWorkspace({ targetId }: SeedsWorkspaceProps) {
  const hydrated = useHydrated();
  const selection = useUrlFilters(seedSelectionCodec);
  const target = useQuery(targetQuery(targetId));
  const seeds = useInfiniteQuery(seedsListQuery(targetId));
  const runId = readId(selection.values.run_id);
  const requestedSeedId = readId(selection.values.seed_id);
  const seedRun = useSeedRun(runId);

  if (!hydrated || target.isPending || seeds.isPending) {
    return <WorkspaceSkeleton />;
  }

  if (target.isError) {
    const missing = isTargetNotFound(target.error);
    return (
      <ErrorState
        title={missing ? "Target not found" : "Could not load the target"}
        description={
          missing
            ? "This target does not exist. Pick another target from the targets list."
            : describeApiError(target.error)
        }
        requestId={readRequestId(target.error)}
        onRetry={missing ? undefined : () => void target.refetch()}
        action={
          missing ? (
            <Button asChild variant="outline">
              <Link href={targetRoutes.list()}>Back to targets</Link>
            </Button>
          ) : undefined
        }
      />
    );
  }

  if (seeds.isError) {
    return (
      <ErrorState
        title="Could not load the seed versions"
        description={describeApiError(seeds.error)}
        requestId={readRequestId(seeds.error)}
        onRetry={() => void seeds.refetch()}
      />
    );
  }

  const { items, total, loadedCount } = seeds.data;
  const latest = items[0];

  if (latest === undefined) {
    return <NoSeedsState targetId={targetId} />;
  }

  const shownId = requestedSeedId ?? latest.id;

  function selectSeed(seedId: string): void {
    selection.setFilters({ seed_id: seedId }, { history: "replace" });
  }

  function showLatest(): void {
    selection.setFilters({ seed_id: undefined }, { history: "replace" });
  }

  function rememberRun(startedRunId: string): void {
    selection.setFilters({ run_id: startedRunId }, { history: "replace" });
  }

  return (
    <div
      data-slot="seeds-workspace"
      aria-busy={seeds.isFetching}
      className="flex min-w-0 flex-col gap-6"
    >
      <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>Target</span>
        <Link
          href={targetRoutes.detail(targetId)}
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          {target.data.name}
        </Link>
        <TargetTierBadge tier={target.data.tier} />
      </p>
      <section aria-labelledby="seed-versions-heading" className="flex flex-col gap-3">
        <h2 id="seed-versions-heading" className="text-sm font-semibold">
          Versions
        </h2>
        <SeedVersions
          seeds={items}
          selectedId={shownId}
          onSelect={selectSeed}
          loadedCount={loadedCount}
          total={total}
          hasNextPage={seeds.hasNextPage}
          isFetchingNextPage={seeds.isFetchingNextPage}
          isFetching={seeds.isFetching}
          onLoadMore={() => void seeds.fetchNextPage()}
        />
      </section>
      <SeedDetail
        key={shownId}
        seedId={shownId}
        listed={items.find((item) => item.id === shownId)}
        isLatest={shownId === latest.id}
        target={target.data}
        seedRun={seedRun}
        runId={runId}
        onRunStarted={rememberRun}
        onShowLatest={showLatest}
      />
    </div>
  );
}

export function SeedsView() {
  return (
    <CurrentTargetGate
      title="Choose a target"
      description="Seeds belong to one target: its reset script and the hash that proves its data is in the known state. Pick a target to see its seed versions."
    >
      {(targetId) => <SeedsWorkspace key={targetId} targetId={targetId} />}
    </CurrentTargetGate>
  );
}
