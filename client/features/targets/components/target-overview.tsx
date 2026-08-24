"use client";

import { useQuery } from "@tanstack/react-query";
import { AgentSessionsPanel } from "@/features/activity/components/agent-sessions-panel";
import { DiscoveryPromptPanel } from "@/features/prompts/components/discovery-prompt-panel";
import { latestDiscoveryIssueQuery } from "@/features/prompts/queries";
import { Skeleton } from "@/components/ui/skeleton";
import { useHydrated } from "@/lib/use-hydrated";
import { targetQuery } from "../queries";
import { LatestBundleCard } from "./latest-bundle-card";
import { PromptHistory } from "./prompt-history";
import { TargetDangerZone } from "./target-danger-zone";
import { TargetSettingsCard } from "./target-settings-card";
import { TokenCard } from "./token-card";

export function TargetOverviewSkeleton() {
  return (
    <div role="status" aria-busy="true" className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <span className="sr-only">Loading the overview</span>
      <Skeleton className="h-96" />
      <Skeleton className="h-96" />
    </div>
  );
}

export function TargetOverview({ targetId }: { targetId: string }) {
  const hydrated = useHydrated();
  const target = useQuery(targetQuery(targetId));
  const latestIssue = useQuery(latestDiscoveryIssueQuery(targetId));

  if (!hydrated || target.data === undefined) {
    return <TargetOverviewSkeleton />;
  }

  const current = target.data;
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
      <div className="flex min-w-0 flex-col gap-6">
        <DiscoveryPromptPanel
          key={current.id}
          target={current}
          initialIssue={latestIssue.data ?? null}
        />
        <PromptHistory targetId={targetId} />
      </div>
      <div className="flex min-w-0 flex-col gap-6">
        <LatestBundleCard targetId={targetId} />
        <AgentSessionsPanel targetId={targetId} />
        <TokenCard target={current} />
        <TargetSettingsCard target={current} />
        <TargetDangerZone target={current} />
      </div>
    </div>
  );
}
