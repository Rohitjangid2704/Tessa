"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Hourglass } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/states/empty-state";
import { Button } from "@/components/ui/button";
import { ReplayDetail } from "@/features/replay/components/replay-detail";
import { latestReplayProgress } from "@/features/replay/model";
import { replaysListQuery } from "@/features/replay/queries";
import { useReplayLiveSync } from "@/features/replay/use-replay-live-sync";
import { replayRoutes } from "@/lib/routes";
import { EventLog } from "../components/event-log";
import { isTerminalRunStatus } from "../run-status";
import { useRunEvents, useRunStreamState } from "../use-run-stream";

export type ReplayViewProps = { runId: string };

export function ReplayView({ runId }: ReplayViewProps) {
  const { run } = useRunStreamState();
  const { events } = useRunEvents();
  const listed = useInfiniteQuery(replaysListQuery());
  const progress = latestReplayProgress(events);
  const replayId =
    progress?.payload.replay_id ??
    listed.data?.items.find((replay) => replay.run_id === runId)?.id ??
    null;
  const terminal = run !== undefined && isTerminalRunStatus(run.status);
  useReplayLiveSync(replayId, progress?.seq ?? 0);

  return (
    <div data-slot="replay-view" data-run-id={runId} className="flex flex-col gap-8">
      {replayId === null ? (
        <EmptyState
          icon={Hourglass}
          data-slot="replay-waiting"
          title={terminal ? "This run ended before it read any record" : "Waiting for the export"}
          description={
            terminal
              ? "No replay was recorded for this run. Check the event log below, then upload the export again."
              : "The server has not started reading the export yet. Progress appears here as records are read."
          }
          action={
            <Button asChild variant="outline">
              <Link href={replayRoutes.list(run?.target_id)}>Open the replays page</Link>
            </Button>
          }
        />
      ) : (
        <ReplayDetail replayId={replayId} live={progress?.payload ?? null} />
      )}
      <EventLog runId={runId} />
    </div>
  );
}
