"use client";

import { History } from "lucide-react";
import { useId } from "react";
import { DateTime } from "@/components/date-time";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { RetentionSweepResult } from "@/lib/api/types";

const countFormatter = new Intl.NumberFormat("en-US");

export const NO_SWEEP_YET_TEXT = "No sweep yet";

export const NO_SWEEP_YET_DETAIL =
  "The retention sweep runs on a schedule. Its first result appears here once it has run.";

interface SweepFigure {
  key: "deleted_steps" | "deleted_artifacts" | "deleted_events";
  label: string;
}

const SWEEP_FIGURES: readonly SweepFigure[] = [
  { key: "deleted_steps", label: "Step payloads purged" },
  { key: "deleted_artifacts", label: "Files deleted" },
  { key: "deleted_events", label: "Run events deleted" },
];

export interface LastSweepCardProps {
  sweep: RetentionSweepResult | null;
}

export function LastSweepCard({ sweep }: LastSweepCardProps) {
  const titleId = useId();
  return (
    <Card role="region" aria-labelledby={titleId} data-section="last-sweep">
      <CardHeader>
        <CardTitle id={titleId} role="heading" aria-level={2} className="flex items-center gap-2">
          <History aria-hidden="true" className="size-4" />
          Last sweep
        </CardTitle>
        <CardDescription>What the most recent retention sweep removed.</CardDescription>
      </CardHeader>
      <CardContent>
        {sweep === null ? (
          <div data-slot="no-sweep" className="flex flex-col gap-1 text-sm">
            <p className="font-medium">{NO_SWEEP_YET_TEXT}</p>
            <p className="text-muted-foreground">{NO_SWEEP_YET_DETAIL}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-sm">
              <span className="text-muted-foreground">Ran </span>
              <DateTime value={sweep.at} className="font-medium" />
            </p>
            <dl className="grid gap-4 sm:grid-cols-3" data-slot="sweep-figures">
              {SWEEP_FIGURES.map((figure) => (
                <div key={figure.key} className="flex flex-col gap-0.5">
                  <dt className="text-sm text-muted-foreground">{figure.label}</dt>
                  <dd className="text-lg font-semibold tabular-nums">
                    {countFormatter.format(sweep[figure.key])}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
