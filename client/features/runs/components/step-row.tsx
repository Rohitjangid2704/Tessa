import { Camera, CircleX, ListX } from "lucide-react";
import Link from "next/link";
import { StatusBadge } from "@/components/status/status-badge";
import { Badge } from "@/components/ui/badge";
import { pluralize } from "@/features/bundles/format";
import type { StepSummary } from "@/lib/api/types";
import { formatUsd } from "@/lib/format-usd";
import { runRoutes } from "@/lib/routes";
import { formatMilliseconds } from "../format";
import { VerdictChips } from "./verdict-chips";

export type ScenarioStepRowProps = {
  runId: string;
  step: StepSummary;
};

export function ScenarioStepRow({ runId, step }: ScenarioStepRowProps) {
  return (
    <li data-slot="step-row" data-step-id={step.id}>
      <Link
        href={runRoutes.step(runId, step.id)}
        scroll={false}
        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-transparent px-2 py-1.5 text-sm outline-none hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          <span className="sr-only">Step </span>#{step.index}
        </span>
        <span className="min-w-0 flex-1 font-medium wrap-break-word">{step.label}</span>
        <Badge variant="outline">{step.adapter}</Badge>
        {step.ok === false ? (
          <StatusBadge tone="verdict-fail" label="Adapter error" icon={CircleX} />
        ) : null}
        {step.tier0_failure_count > 0 ? (
          <StatusBadge
            tone="verdict-fail"
            label={pluralize(step.tier0_failure_count, "Tier 0 failure")}
            icon={ListX}
          />
        ) : null}
        {step.screenshot_count > 0 ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
            <Camera aria-hidden="true" className="size-3" />
            {step.screenshot_count}
            <span className="sr-only"> screenshots</span>
          </span>
        ) : null}
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatMilliseconds(step.latency_ms)}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatUsd(step.cost_usd)}
        </span>
        {step.verdict === null ? (
          <span className="text-xs text-muted-foreground">Not graded yet</span>
        ) : (
          <VerdictChips verdict={step.verdict} />
        )}
      </Link>
    </li>
  );
}
