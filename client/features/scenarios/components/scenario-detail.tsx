"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { DateTime } from "@/components/date-time";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TargetName } from "@/features/targets/components/target-name";
import { describeApiError } from "@/lib/api/errors";
import type { Scenario } from "@/lib/api/types";
import { scenarioRoutes, targetRoutes } from "@/lib/routes";
import { useHydrated } from "@/lib/use-hydrated";
import { SCENARIO_ORIGIN_LABELS } from "../labels";
import { isScenarioNotFound, scenarioQuery } from "../queries";
import { ProvenancePanel } from "./provenance-panel";
import { ScenarioEditor } from "./scenario-editor";
import { ScenarioStatusBadge } from "./scenario-status-badge";
import { StatusMenu } from "./status-menu";

function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm wrap-break-word">{children}</dd>
    </div>
  );
}

function ScenarioDetailSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-6">
      <span className="sr-only">Loading the scenario</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-80 max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-96 w-full" />
    </div>
  );
}

function BackToScenarios({ targetId }: { targetId?: string }) {
  return (
    <Button asChild variant="ghost" size="sm" className="w-fit">
      <Link href={scenarioRoutes.list({ target_id: targetId })}>
        <ArrowLeft aria-hidden="true" data-icon="inline-start" />
        Back to scenarios
      </Link>
    </Button>
  );
}

function ScenarioDetailBody({ scenario }: { scenario: Scenario }) {
  return (
    <article data-slot="scenario-detail" className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <BackToScenarios targetId={scenario.target_id} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight wrap-break-word">
              {scenario.title}
            </h1>
            <ScenarioStatusBadge status={scenario.status} />
            {scenario.synthetic ? <Badge variant="outline">Synthetic</Badge> : null}
          </div>
          <StatusMenu scenario={scenario} />
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
          <MetaItem label="Origin">{SCENARIO_ORIGIN_LABELS[scenario.origin]}</MetaItem>
          <MetaItem label="Version">v{scenario.version}</MetaItem>
          <MetaItem label="Family">
            <code className="font-mono text-xs">{scenario.family}</code>
          </MetaItem>
          <MetaItem label="Feature">
            {scenario.feature_id === null ? (
              <span className="text-muted-foreground">None</span>
            ) : (
              <code className="font-mono text-xs">{scenario.feature_id}</code>
            )}
          </MetaItem>
          <MetaItem label="Target">
            <TargetName targetId={scenario.target_id} />
          </MetaItem>
          <MetaItem label="Bundle">
            <Link
              href={targetRoutes.bundle(scenario.target_id, scenario.bundle_id)}
              className="underline-offset-4 hover:underline"
            >
              Open the bundle
            </Link>
          </MetaItem>
          <MetaItem label="Created">
            <DateTime value={scenario.created_at} />
          </MetaItem>
          <MetaItem label="Updated">
            <DateTime value={scenario.updated_at} />
          </MetaItem>
          <MetaItem label="Scenario id">
            <span className="inline-flex items-center gap-1">
              <code className="font-mono text-xs">{scenario.id}</code>
              <CopyButton text={scenario.id} subject="scenario id" variant="ghost" size="xs" />
            </span>
          </MetaItem>
        </dl>
      </header>
      <ScenarioEditor
        key={scenario.id}
        scenario={scenario}
        aside={<ProvenancePanel scenarioId={scenario.id} targetId={scenario.target_id} />}
      />
    </article>
  );
}

export function ScenarioDetail({ scenarioId }: { scenarioId: string }) {
  const hydrated = useHydrated();
  const query = useQuery(scenarioQuery(scenarioId));

  if (!hydrated || query.isPending) {
    return <ScenarioDetailSkeleton />;
  }

  const scenario = query.data;
  if (scenario === undefined) {
    const notFound = isScenarioNotFound(query.error);
    return (
      <ErrorState
        title={notFound ? "Scenario not found" : "Could not load the scenario"}
        description={
          notFound
            ? "This scenario does not exist or was removed. Pick another one from the library."
            : describeApiError(query.error)
        }
        requestId={readRequestId(query.error)}
        onRetry={notFound ? undefined : () => void query.refetch()}
        action={<BackToScenarios />}
      />
    );
  }

  return <ScenarioDetailBody scenario={scenario} />;
}
