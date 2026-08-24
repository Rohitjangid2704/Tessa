"use client";

import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import Link from "next/link";
import { DateTime } from "@/components/date-time";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { StatusBadge } from "@/components/status/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TargetTierBadge } from "@/features/targets/components/target-tier-badge";
import type { Target } from "@/features/targets/types";
import { describeApiError, isApiError } from "@/lib/api/errors";
import { runRoutes } from "@/lib/routes";
import { seedQuery } from "../queries";
import type { Seed } from "../types";
import { HashCompare } from "./hash-compare";
import { ResultStatusBadge } from "./result-status-badge";
import { ScriptPreview } from "./script-preview";
import { SeedActions } from "./seed-actions";
import { SeedRunStatus, type SeedRunState } from "./seed-run-status";

export interface SeedDetailProps {
  seedId: string;
  listed: Seed | undefined;
  isLatest: boolean;
  target: Pick<Target, "id" | "name" | "tier" | "archived_at">;
  seedRun: SeedRunState;
  runId: string | null;
  onRunStarted: (runId: string) => void;
  onShowLatest: () => void;
}

function DetailSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading the seed version</span>
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

function LastResult({ seed }: { seed: Seed }) {
  return (
    <dl
      data-slot="last-result"
      className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground"
    >
      <div className="flex items-center gap-1.5">
        <dt>Last result</dt>
        <dd>
          <ResultStatusBadge status={seed.last_reset_status} />
        </dd>
      </div>
      <div className="flex items-center gap-1.5">
        <dt>Finished</dt>
        <dd className="font-medium text-foreground">
          <DateTime value={seed.last_reset_at} fallback="Never reset" />
        </dd>
      </div>
      {seed.last_reset_run_id === null ? null : (
        <div className="flex items-center gap-1.5">
          <dt className="sr-only">Run</dt>
          <dd>
            <Link
              href={runRoutes.detail(seed.last_reset_run_id)}
              className="font-medium text-foreground underline underline-offset-4"
            >
              Open the last seed run
            </Link>
          </dd>
        </div>
      )}
    </dl>
  );
}

export function SeedDetail({
  seedId,
  listed,
  isLatest,
  target,
  seedRun,
  runId,
  onRunStarted,
  onShowLatest,
}: SeedDetailProps) {
  const query = useQuery({ ...seedQuery(seedId), placeholderData: listed });
  const production = target.tier === "production";

  if (query.isPending) {
    return <DetailSkeleton />;
  }

  const foreign = query.data !== undefined && query.data.target_id !== target.id;

  if (query.isError || foreign) {
    const missing = foreign || (isApiError(query.error) && [404, 422].includes(query.error.status));
    return (
      <ErrorState
        title={missing ? "Seed version not found" : "Could not load the seed version"}
        description={
          missing
            ? "This seed version does not exist for this target. Pick another one from the list."
            : describeApiError(query.error)
        }
        requestId={readRequestId(query.error)}
        onRetry={missing ? undefined : () => void query.refetch()}
        action={
          missing ? (
            <Button variant="outline" onClick={onShowLatest}>
              Show the latest version
            </Button>
          ) : undefined
        }
      />
    );
  }

  const seed = query.data;
  return (
    <article
      data-slot="seed-detail"
      data-seed-id={seed.id}
      aria-labelledby={`seed-${seed.id}-heading`}
      className="flex min-w-0 flex-col gap-6"
    >
      <header className="flex flex-wrap items-center gap-2">
        <h2 id={`seed-${seed.id}-heading`} className="text-lg font-semibold">
          Seed version {seed.version}
        </h2>
        {isLatest ? <Badge variant="outline">Latest</Badge> : null}
        <TargetTierBadge tier={target.tier} />
        {seed.has_reset_script ? null : (
          <StatusBadge tone="hollow" label="No reset script" icon={ShieldAlert} />
        )}
      </header>

      {production ? (
        <Alert role="group" aria-label="Production target" data-slot="production-notice">
          <ShieldAlert aria-hidden="true" />
          <AlertTitle>Production target</AlertTitle>
          <AlertDescription>
            Verify and reset are blocked here, always. Both would write to or probe the live data.
            The hashes below are read-only.
          </AlertDescription>
        </Alert>
      ) : null}

      <HashCompare
        declared={seed.declared_hash}
        observed={seed.observed_hash}
        hashSource={seed.hash_source}
      />

      <LastResult seed={seed} />

      <section aria-label="Actions" className="flex flex-col gap-3">
        <SeedActions
          seed={seed}
          target={target}
          runActive={seedRun.active}
          onRunStarted={onRunStarted}
        />
        {runId === null ? null : <SeedRunStatus runId={runId} state={seedRun} />}
      </section>

      <ScriptPreview seed={seed} />
    </article>
  );
}
