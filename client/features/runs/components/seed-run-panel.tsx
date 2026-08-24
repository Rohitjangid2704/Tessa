"use client";

import { CircleCheck, CircleDashed, CircleMinus, CircleX, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { HashCompare } from "@/features/seeds/components/hash-compare";
import { SEED_PHASE_LABELS } from "@/features/seeds/hash-state";
import { seedRoutes } from "@/lib/routes";
import { useThrottledValue } from "@/lib/use-throttled-value";
import { cn } from "@/lib/utils";
import { isTerminalRunStatus } from "../run-status";
import {
  summarizeSeedRun,
  type SeedPhaseState,
  type SeedPhaseView,
  type SeedRunSummary,
} from "../seed-phases";
import { useRunEvents, useRunStreamState } from "../use-run-stream";

export const SEED_ANNOUNCEMENT_INTERVAL_MS = 2000;

const STATE_LABELS: Record<SeedPhaseState, string> = {
  pending: "Waiting",
  started: "Running",
  ok: "OK",
  failed: "Failed",
  not_run: "Not run",
};

const STATE_TEXT_CLASSES: Record<SeedPhaseState, string> = {
  pending: "text-muted-foreground",
  started: "text-live-live-fg",
  ok: "text-verdict-pass-fg",
  failed: "font-semibold text-verdict-fail-fg",
  not_run: "text-muted-foreground",
};

export type SeedRunAction = "reset" | "verify" | null;

export function seedRunActionOf(summary: SeedRunSummary): SeedRunAction {
  const [reset, hash] = summary.phases;
  if (reset !== undefined && reset.state !== "pending" && reset.state !== "not_run") {
    return "reset";
  }
  if (hash !== undefined && hash.state !== "pending" && hash.state !== "not_run") {
    return "verify";
  }
  return null;
}

export function describeSeedAnnouncement(summary: SeedRunSummary): string {
  if (summary.lastEvent === null) {
    return "";
  }
  const { phase, status } = summary.lastEvent;
  return `${SEED_PHASE_LABELS[phase]} ${STATE_LABELS[status].toLowerCase()}`;
}

function PhaseIcon({ state }: { state: SeedPhaseState }) {
  const className = cn("size-4 shrink-0", STATE_TEXT_CLASSES[state]);
  switch (state) {
    case "ok":
      return <CircleCheck aria-hidden="true" className={className} />;
    case "failed":
      return <CircleX aria-hidden="true" className={className} />;
    case "started":
      return (
        <LoaderCircle
          aria-hidden="true"
          className={cn(className, "animate-spin motion-reduce:animate-none")}
        />
      );
    case "not_run":
      return <CircleMinus aria-hidden="true" className={className} />;
    case "pending":
      return <CircleDashed aria-hidden="true" className={className} />;
  }
}

function PhaseRow({ view }: { view: SeedPhaseView }) {
  return (
    <li
      data-slot="seed-phase"
      data-phase={view.phase}
      data-state={view.state}
      className="flex items-center gap-3 rounded-lg border px-3 py-2"
    >
      <PhaseIcon state={view.state} />
      <span className="text-sm font-medium">{SEED_PHASE_LABELS[view.phase]}</span>
      <span className={cn("ml-auto text-sm", STATE_TEXT_CLASSES[view.state])}>
        {STATE_LABELS[view.state]}
      </span>
    </li>
  );
}

export type SeedRunPanelProps = { runId: string };

export function SeedRunPanel({ runId }: SeedRunPanelProps) {
  const headingId = useId();
  const { run } = useRunStreamState();
  const { events } = useRunEvents();
  const terminal = run !== undefined && isTerminalRunStatus(run.status);
  const summary = summarizeSeedRun(events, terminal);
  const action = seedRunActionOf(summary);
  const announced = useThrottledValue(
    describeSeedAnnouncement(summary),
    SEED_ANNOUNCEMENT_INTERVAL_MS,
  );
  const failed = run?.status === "failed" || summary.failedPhase !== null;
  const hasHashes = summary.observedHash !== null || summary.expectedHash !== null;
  const showHashes = hasHashes || (terminal && summary.phases.some((view) => view.state === "ok"));

  return (
    <section
      aria-labelledby={headingId}
      data-slot="seed-run-panel"
      data-run-id={runId}
      data-state={run?.status}
      className="flex flex-col gap-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-base font-semibold">
          {action === "reset" ? "Seed reset" : action === "verify" ? "Seed verify" : "Seed run"}
        </h2>
        {run?.target_id == null ? null : (
          <Button asChild variant="outline" size="sm">
            <Link href={seedRoutes.list(run.target_id)}>Open the seeds page</Link>
          </Button>
        )}
      </div>

      <p role="status" className="sr-only">
        {announced}
      </p>

      <ol aria-label="Seed phases" data-slot="seed-phases" className="flex flex-col gap-2">
        {summary.phases.map((view) => (
          <PhaseRow key={view.phase} view={view} />
        ))}
      </ol>

      {showHashes ? (
        <HashCompare
          declared={summary.expectedHash}
          observed={summary.observedHash}
          hashSource={null}
          declaredLabel="Expected"
          observedLabel="Observed"
        />
      ) : null}

      {failed ? (
        <Alert variant="destructive" data-slot="seed-run-failed">
          <CircleX aria-hidden="true" />
          <AlertTitle>
            The seed run failed
            {summary.failedPhase === null
              ? ""
              : ` in the ${SEED_PHASE_LABELS[summary.failedPhase].toLowerCase()} phase`}
          </AlertTitle>
          <AlertDescription>
            <p>
              {summary.failureReason ??
                "The run ended without a reason. Check the event log and the worker."}
            </p>
            <p>The data may not be in the seed state until a reset succeeds.</p>
          </AlertDescription>
        </Alert>
      ) : null}

      {terminal && !failed ? (
        <p data-slot="seed-run-outcome" className="text-sm text-muted-foreground">
          {run?.status === "completed"
            ? "The seed run finished with every phase that ran passing."
            : "The seed run ended before it finished."}
        </p>
      ) : null}
    </section>
  );
}
