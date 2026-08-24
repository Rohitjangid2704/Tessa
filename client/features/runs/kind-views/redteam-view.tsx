"use client";

import { LandedFindings } from "@/features/redteam/components/landed-findings";
import { RedteamRunPanel } from "@/features/redteam/components/redteam-run-panel";
import { summarizeRedteamEvents } from "@/features/redteam/model";
import { useRedteamLiveSync } from "@/features/redteam/use-redteam-live-sync";
import { EventLog } from "../components/event-log";
import { isTerminalRunStatus } from "../run-status";
import { useRunEvents, useRunStreamState } from "../use-run-stream";

export type RedteamViewProps = { runId: string };

export function RedteamView({ runId }: RedteamViewProps) {
  const { run, status } = useRunStreamState();
  const { events } = useRunEvents();
  const summary = summarizeRedteamEvents(events);
  const runActive = run !== undefined && !isTerminalRunStatus(run.status);
  useRedteamLiveSync(runId, summary.lastSeq, summary.findings.length);

  return (
    <div data-slot="redteam-view" data-run-id={runId} className="flex flex-col gap-8">
      <RedteamRunPanel
        runId={runId}
        runActive={runActive}
        liveRounds={summary.rounds}
        polling={status !== "live"}
      />
      <LandedFindings findings={summary.findings} runActive={runActive} />
      <EventLog runId={runId} />
    </div>
  );
}
