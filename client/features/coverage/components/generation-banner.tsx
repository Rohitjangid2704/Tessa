"use client";

import { useQuery } from "@tanstack/react-query";
import { CircleCheck, LoaderCircle, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { pluralize } from "@/features/bundles/format";
import { RUN_TERMINAL_STATUSES } from "@/lib/api/polling";
import type { RunStatus } from "@/lib/api/types";
import { runRoutes, scenarioRoutes } from "@/lib/routes";
import { useThrottledValue } from "@/lib/use-throttled-value";
import {
  activeGenerationRunsQuery,
  generationProgressQuery,
  generationRunQuery,
} from "../queries";
import type { GenerationProgressPayload } from "../types";

export interface GenerationBannerProps {
  targetId: string;
  trackedRunIds: readonly string[];
}

const ANNOUNCE_INTERVAL_MS = 2000;
const PERCENT = 100;

type Outcome = "active" | "finished" | "failed";

function outcomeOf(status: RunStatus | undefined): Outcome {
  if (status === undefined || !(RUN_TERMINAL_STATUSES as readonly RunStatus[]).includes(status)) {
    return "active";
  }
  return status === "completed" ? "finished" : "failed";
}

function describeProgress(progress: GenerationProgressPayload | undefined): string {
  if (progress === undefined) {
    return "Waiting for the first cell";
  }
  const parts = [
    `${progress.cells_done} of ${pluralize(progress.cells_total, "cell")} done`,
    `${pluralize(progress.scenarios_created, "scenario")} created`,
  ];
  if (progress.scenarios_invalid > 0) {
    parts.push(`${progress.scenarios_invalid} invalid`);
  }
  return parts.join(", ");
}

function percentOf(progress: GenerationProgressPayload | undefined): number {
  if (progress === undefined || progress.cells_total === 0) {
    return 0;
  }
  return Math.min(PERCENT, Math.round((progress.cells_done / progress.cells_total) * PERCENT));
}

const HEADLINES: Record<Outcome, string> = {
  active: "Generating scenarios",
  finished: "Generation finished",
  failed: "Generation stopped before it finished",
};

function GenerationRunCard({ runId, onDismiss }: { runId: string; onDismiss: () => void }) {
  const progress = useQuery(generationProgressQuery(runId)).data;
  const run = useQuery(generationRunQuery(runId)).data;
  const outcome = outcomeOf(run?.status);
  const summary = describeProgress(progress);
  const announced = useThrottledValue(`${HEADLINES[outcome]}: ${summary}`, ANNOUNCE_INTERVAL_MS);
  const Icon = outcome === "active" ? LoaderCircle : outcome === "finished" ? CircleCheck : TriangleAlert;

  return (
    <Alert
      data-slot="generation-banner"
      data-outcome={outcome}
      variant={outcome === "failed" ? "destructive" : "default"}
    >
      <Icon aria-hidden="true" className={outcome === "active" ? "motion-safe:animate-spin" : undefined} />
      <AlertTitle>{HEADLINES[outcome]}</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <p>{summary}</p>
        <Progress
          value={outcome === "finished" ? PERCENT : percentOf(progress)}
          aria-label="Generation progress"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={runRoutes.detail(runId)}>Open the run</Link>
          </Button>
          {outcome === "finished" ? (
            <Button asChild variant="outline" size="sm">
              <Link href={scenarioRoutes.review()}>Review the scenarios</Link>
            </Button>
          ) : null}
          {outcome === "active" ? null : (
            <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
              Dismiss
            </Button>
          )}
        </div>
        <p role="status" className="sr-only">
          {announced}
        </p>
      </AlertDescription>
    </Alert>
  );
}

export function GenerationBanner({ targetId, trackedRunIds }: GenerationBannerProps) {
  const active = useQuery(activeGenerationRunsQuery(targetId));
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const runIds = [...new Set([...trackedRunIds, ...(active.data ?? []).map((run) => run.id)])].filter(
    (runId) => !dismissed.has(runId),
  );

  if (runIds.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2" data-slot="generation-banners">
      {runIds.map((runId) => (
        <GenerationRunCard
          key={runId}
          runId={runId}
          onDismiss={() => setDismissed((previous) => new Set(previous).add(runId))}
        />
      ))}
    </div>
  );
}
