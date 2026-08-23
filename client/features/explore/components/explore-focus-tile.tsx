"use client";

import { useQuery } from "@tanstack/react-query";
import { MonitorOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { EmptyState } from "@/components/states/empty-state";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  attemptLabel,
  EndedPlaceholder,
  TileCaption,
  TileStatusBadge,
} from "@/features/runs/components/screencast-tile";
import { FOCUS_PREVIEW_WIDTH } from "@/features/runs/components/tile-focus-dialog";
import { runBrowserSessionsQuery } from "@/features/runs/run-detail-queries";
import { TileActivityStore, useTileActivity } from "@/features/runs/tile-activity";
import {
  isSessionEnded,
  mergeTileSessions,
  orderTileSessions,
  previewSize,
  type TileSession,
} from "@/features/runs/tile-sessions";
import { STALE_CHECK_INTERVAL_MS, deriveTileState, tileConnection } from "@/features/runs/tile-state";
import { useRunStreamHandle, useRunStreamState } from "@/features/runs/use-run-stream";
import { useSessionEvents } from "@/features/runs/use-session-events";
import type { BrowserSession } from "@/lib/api/types";
import { runRoutes } from "@/lib/routes";
import { useNow } from "@/lib/use-now";
import { ScreencastCanvas } from "@/lib/ws/screencast-canvas";

const NO_SESSIONS: readonly BrowserSession[] = [];

export type ExploreFocusTileProps = {
  runId: string;
  lastStepId: string | null;
};

function pickSession(sessions: readonly TileSession[], runEnded: boolean): TileSession | null {
  return (
    sessions.find((session) => !isSessionEnded(session, runEnded)) ?? sessions.at(-1) ?? null
  );
}

function FocusSession({
  runId,
  session,
  ended,
  lastStepId,
}: {
  runId: string;
  session: TileSession;
  ended: boolean;
  lastStepId: string | null;
}) {
  const router = useRouter();
  const { frameBus } = useRunStreamHandle();
  const { status, replayComplete } = useRunStreamState();
  const [activity] = useState(() => new TileActivityStore());
  const frameActivity = useTileActivity(activity, session.id);
  const now = useNow(STALE_CHECK_INTERVAL_MS);
  const state = deriveTileState({
    ended,
    connection: tileConnection(status, replayComplete),
    paused: false,
    lastFrameAt: frameActivity?.lastFrameAt ?? null,
    now,
  });
  const size = previewSize(session.viewport, FOCUS_PREVIEW_WIDTH);
  const pageUrl = frameActivity?.pageUrl ?? session.lastUrl;

  return (
    <Card
      data-slot="explore-focus-tile"
      data-tile-state={state}
      data-session-id={session.id}
      className="gap-0 overflow-hidden p-0"
    >
      <div className="relative bg-muted">
        {ended ? (
          <EndedPlaceholder
            session={session}
            stepsPending={lastStepId === null}
            onOpenSteps={() => {
              if (lastStepId !== null) {
                router.push(runRoutes.step(runId, lastStepId), { scroll: false });
              }
            }}
          />
        ) : (
          <>
            <ScreencastCanvas
              bus={frameBus}
              sessionId={session.id}
              mode="focus"
              label={`Focus view of the explorer browser, ${attemptLabel(session)}`}
              width={size.width}
              height={size.height}
              onFrame={(frame) => activity.record(session.id, frame, Date.now())}
              className="mx-auto h-auto max-h-[65dvh] w-full"
            />
            <TileStatusBadge state={state} className="absolute top-2 left-2" />
          </>
        )}
      </div>
      <TileCaption session={session} pageUrl={pageUrl} />
    </Card>
  );
}

export function ExploreFocusTile({ runId, lastStepId }: ExploreFocusTileProps) {
  const { isTerminal } = useRunStreamState();
  const sessionsQuery = useQuery(runBrowserSessionsQuery(runId));
  const sessionEvents = useSessionEvents();
  const restItems = sessionsQuery.data?.items;
  const sessions = useMemo(
    () => orderTileSessions(mergeTileSessions(restItems ?? NO_SESSIONS, sessionEvents), isTerminal),
    [restItems, sessionEvents, isTerminal],
  );
  const session = pickSession(sessions, isTerminal);

  if (session === null) {
    if (sessionsQuery.isPending) {
      return (
        <div role="status" aria-busy="true" data-slot="explore-focus-tile-loading">
          <span className="sr-only">Loading the explorer browser</span>
          <Skeleton className="aspect-[8/5] w-full rounded-xl" />
        </div>
      );
    }
    return (
      <EmptyState
        icon={MonitorOff}
        title={isTerminal ? "No browser session was recorded" : "Waiting for the browser"}
        description={
          isTerminal
            ? "This run ended without opening a browser session."
            : "The explorer opens a browser session when it starts. Frames appear here as it navigates."
        }
        className="py-10"
      />
    );
  }

  return (
    <FocusSession
      key={session.id}
      runId={runId}
      session={session}
      ended={isSessionEnded(session, isTerminal)}
      lastStepId={lastStepId}
    />
  );
}
