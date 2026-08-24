"use client";

import Link from "next/link";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { pluralize } from "@/features/bundles/format";
import type { KnownStreamEvent } from "@/features/streams/events";
import type { GenerationProgressPayload } from "@/lib/api/types";
import { coverageRoutes, scenarioRoutes } from "@/lib/routes";
import { useThrottledValue } from "@/lib/use-throttled-value";
import { useRunEvents, useRunStreamState } from "../use-run-stream";

const ANNOUNCE_INTERVAL_MS = 2000;
const PERCENT = 100;

export function latestGenerationProgress(
  events: readonly KnownStreamEvent[],
): GenerationProgressPayload | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && event.type === "generation.progress") {
      return event.payload;
    }
  }
  return null;
}

export function describeGenerationProgress(progress: GenerationProgressPayload | null): string {
  if (progress === null) {
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

function percentOf(progress: GenerationProgressPayload | null): number {
  if (progress === null || progress.cells_total === 0) {
    return 0;
  }
  return Math.min(PERCENT, Math.round((progress.cells_done / progress.cells_total) * PERCENT));
}

export function GenerateProgress() {
  const headingId = useId();
  const { events } = useRunEvents();
  const { run } = useRunStreamState();
  const progress = latestGenerationProgress(events);
  const summary = describeGenerationProgress(progress);
  const announced = useThrottledValue(summary, ANNOUNCE_INTERVAL_MS);
  const targetId = run?.target_id ?? null;

  return (
    <section
      aria-labelledby={headingId}
      data-slot="generate-progress"
      className="flex flex-col gap-3 rounded-xl border p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-base font-semibold">
          Scenario generation
        </h2>
        <div className="flex flex-wrap gap-2">
          {targetId === null ? null : (
            <Button asChild variant="outline" size="sm">
              <Link href={coverageRoutes.map(targetId)}>Open coverage</Link>
            </Button>
          )}
          {targetId === null ? null : (
            <Button asChild variant="outline" size="sm">
              <Link href={scenarioRoutes.review({ target_id: targetId })}>Open review queue</Link>
            </Button>
          )}
        </div>
      </div>
      <Progress
        value={percentOf(progress)}
        aria-label="Generation progress"
        aria-valuetext={summary}
      />
      <p className="text-sm text-muted-foreground" data-slot="generate-summary">
        {summary}
      </p>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announced}
      </div>
    </section>
  );
}
