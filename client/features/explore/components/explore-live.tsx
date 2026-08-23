"use client";

import { Hourglass } from "lucide-react";
import Link from "next/link";
import { useId, useMemo } from "react";
import { FindingStatusBadge } from "@/components/status/finding-status-badge";
import { SeverityBadge } from "@/components/status/severity-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useRunEvents, useRunStreamHandle, useRunStreamState } from "@/features/runs/use-run-stream";
import { findingRoutes } from "@/lib/routes";
import { deriveExploreSnapshot, type FoundFinding } from "../model";
import { ActionTimeline } from "./action-timeline";
import { CandidateCard } from "./candidate-card";
import { ExploreFocusTile } from "./explore-focus-tile";
import { RecordingPlayer } from "./recording-player";
import { StepCounter } from "./step-counter";

export type ExploreLiveProps = { runId: string };

function FoundFindingItem({ finding }: { finding: FoundFinding }) {
  return (
    <li
      data-slot="found-finding"
      data-finding-id={finding.findingId}
      className="flex flex-wrap items-center gap-2 rounded-xl border p-3"
    >
      <SeverityBadge severity={finding.severity} />
      <FindingStatusBadge status={finding.status} />
      <span className="min-w-0 flex-1 text-sm font-medium wrap-break-word">{finding.title}</span>
      <Button asChild size="sm" variant="outline">
        <Link href={findingRoutes.detail(finding.findingId)}>
          Open the finding
          <span className="sr-only">: {finding.title}</span>
        </Link>
      </Button>
    </li>
  );
}

export function ExploreLive({ runId }: ExploreLiveProps) {
  const candidatesHeadingId = useId();
  const findingsHeadingId = useId();
  const recordingHeadingId = useId();
  const { events: feed } = useRunStreamHandle();
  const { run, isTerminal } = useRunStreamState();
  const { events, hasOlder, loadingOlder } = useRunEvents();
  const snapshot = useMemo(() => deriveExploreSnapshot(events, isTerminal), [events, isTerminal]);

  const stopping = run !== undefined && run.stop_requested_at !== null && !isTerminal;
  const phase = isTerminal ? "ended" : snapshot.finishedExploring ? "verifying" : "exploring";
  const pending = snapshot.candidates.filter((candidate) => candidate.state === "verifying");

  return (
    <section
      aria-label="Explorer session"
      data-slot="explore-live"
      data-phase={phase}
      className="flex flex-col gap-6"
    >
      {run === undefined ? null : (
        <StepCounter actionCount={snapshot.actionCount} budget={run.budget} phase={phase} />
      )}
      {stopping ? (
        <Alert role="status" data-slot="stop-note">
          <Hourglass aria-hidden="true" />
          <AlertTitle>Stopping after the current step</AlertTitle>
          <AlertDescription>
            {pending.length > 0
              ? `${pending.length} possible ${pending.length === 1 ? "issue is" : "issues are"} still being verified before the run ends.`
              : "Anything the explorer already found is verified before the run ends."}
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <ExploreFocusTile runId={runId} lastStepId={snapshot.lastStepId} />
        </div>
        <ActionTimeline
          runId={runId}
          actions={snapshot.actions}
          live={!isTerminal}
          hasOlder={hasOlder}
          loadingOlder={loadingOlder}
          onLoadOlder={() => void feed.loadOlder()}
        />
      </div>
      <section aria-labelledby={candidatesHeadingId} className="flex flex-col gap-3">
        <h2 id={candidatesHeadingId} className="text-base font-semibold">
          Candidates
        </h2>
        {snapshot.candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-slot="no-candidates">
            {isTerminal
              ? "The explorer found nothing that looked wrong."
              : "Nothing suspicious so far. A possible issue shows up here and is verified by replaying its steps."}
          </p>
        ) : (
          <ul aria-label="Candidates" className="grid gap-3 lg:grid-cols-2">
            {snapshot.candidates.map((candidate) => (
              <CandidateCard key={candidate.candidateId} runId={runId} candidate={candidate} />
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby={findingsHeadingId} className="flex flex-col gap-3">
        <h2 id={findingsHeadingId} className="text-base font-semibold">
          Found in this run
        </h2>
        {snapshot.findings.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-slot="no-findings">
            {isTerminal
              ? "No finding was confirmed in this run. Candidates that could not be reproduced never reach the board."
              : "Confirmed findings land here and on the findings board."}
          </p>
        ) : (
          <ul aria-label="Findings found in this run" className="flex flex-col gap-2">
            {snapshot.findings.map((finding) => (
              <FoundFindingItem key={finding.findingId} finding={finding} />
            ))}
          </ul>
        )}
      </section>
      {isTerminal && snapshot.lastStepId !== null ? (
        <section aria-labelledby={recordingHeadingId} className="flex flex-col gap-3">
          <h2 id={recordingHeadingId} className="text-base font-semibold">
            Recording
          </h2>
          <RecordingPlayer stepId={snapshot.lastStepId} />
        </section>
      ) : null}
    </section>
  );
}
