"use client";

import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentTarget } from "@/features/targets/current-target";
import { dashboardQuery } from "../queries";
import { useHomeFeed } from "../use-home-feed";
import { CostTile } from "./cost-tile";
import { FindingsBySeverity } from "./findings-by-severity";
import { BudgetBanner, HomeStatusBar, isFeedStale, StaleBanner } from "./home-status";
import { KappaTile } from "./kappa-tile";
import { LastRunsTable } from "./last-runs-table";
import { LiveProbesPanel } from "./live-probes-panel";
import { MutationCard } from "./mutation-card";
import { PassKTile } from "./passk-tile";
import { SuitePowerTile } from "./suite-power-tile";

const SKELETON_TILES = 5;

function HomeSkeleton() {
  return (
    <div role="status" aria-busy="true" data-slot="home-skeleton" className="flex flex-col gap-4">
      <span className="sr-only">Loading the dashboard</span>
      <Skeleton className="h-5 w-48" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: SKELETON_TILES }, (_, index) => (
          <Skeleton key={index} className="h-40 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}

type HomeBodyProps = {
  targetId: string | null;
  onRestartFeed: () => void;
};

function HomeBody({ targetId, onRestartFeed }: HomeBodyProps) {
  const tilesHeadingId = useId();
  const dashboard = useQuery(dashboardQuery(targetId));
  const feed = useHomeFeed(targetId);

  return (
    <div data-slot="home-dashboard" className="flex flex-col gap-4">
      <HomeStatusBar targetId={targetId} state={feed.state} />
      {isFeedStale(feed.state) ? <StaleBanner state={feed.state} onRetry={onRestartFeed} /> : null}
      {feed.budgetNotice === null ? null : (
        <BudgetBanner notice={feed.budgetNotice} onDismiss={feed.dismissBudgetNotice} />
      )}
      <section aria-labelledby={tilesHeadingId} className="flex flex-col gap-3">
        <h2 id={tilesHeadingId} className="sr-only">
          Key figures
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <PassKTile targetId={targetId} dashboard={dashboard} />
          <FindingsBySeverity targetId={targetId} dashboard={dashboard} />
          <CostTile dashboard={dashboard} />
          <SuitePowerTile targetId={targetId} dashboard={dashboard} />
          <KappaTile targetId={targetId} dashboard={dashboard} />
          <MutationCard targetId={targetId} />
          <LiveProbesPanel targetId={targetId} className="sm:col-span-2 xl:col-span-3" />
        </div>
      </section>
      <LastRunsTable targetId={targetId} dashboard={dashboard} />
    </div>
  );
}

export function HomeDashboard() {
  const { targetId: currentTargetId, source, isResolved } = useCurrentTarget();
  const targetId = source === "default" ? null : currentTargetId;
  const [restarts, setRestarts] = useState(0);

  if (!isResolved) {
    return <HomeSkeleton />;
  }
  return (
    <HomeBody
      key={`${targetId ?? "all"}:${restarts}`}
      targetId={targetId}
      onRestartFeed={() => setRestarts((count) => count + 1)}
    />
  );
}
