"use client";

import { useQuery } from "@tanstack/react-query";
import { MonitorOff, Pause, Play } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError, isApiError } from "@/lib/api/errors";
import type { BrowserSession } from "@/lib/api/types";
import { useMediaQuery } from "@/lib/use-media-query";
import { useThrottledValue } from "@/lib/use-throttled-value";
import { DEFAULT_MAX_TILES } from "@/lib/ws/frame-bus";
import { runBrowserSessionsQuery } from "../run-detail-queries";
import { TileActivityStore } from "../tile-activity";
import {
  isSessionEnded,
  mergeTileSessions,
  orderTileSessions,
  type TileSession,
} from "../tile-sessions";
import { tileConnection } from "../tile-state";
import { useOpenScenarioSteps } from "../use-open-scenario-steps";
import { useRunStreamHandle, useRunStreamState } from "../use-run-stream";
import { useSessionEvents } from "../use-session-events";
import { ScreencastTile } from "./screencast-tile";
import { TileFocusDialog } from "./tile-focus-dialog";

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
export const TILE_ANNOUNCEMENT_INTERVAL_MS = 2000;

export type TileGridProps = { runId: string };

const NO_SESSIONS: readonly BrowserSession[] = [];
const SKELETON_TILES = [0, 1, 2];

export function TileGrid({ runId }: TileGridProps) {
  const headingId = useId();
  const { frameBus } = useRunStreamHandle();
  const { run, status, replayComplete, isTerminal, limits } = useRunStreamState();
  const sessionsQuery = useQuery(runBrowserSessionsQuery(runId));
  const sessionEvents = useSessionEvents();
  const [activity] = useState(() => new TileActivityStore());
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const [pauseChoice, setPauseChoice] = useState<boolean | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [extraPages, setExtraPages] = useState(0);
  const openSteps = useOpenScenarioSteps(runId);

  const restItems = sessionsQuery.data?.items;
  const sessions = useMemo(
    () => orderTileSessions(mergeTileSessions(restItems ?? NO_SESSIONS, sessionEvents), isTerminal),
    [restItems, sessionEvents, isTerminal],
  );

  const paused = pauseChoice ?? reducedMotion;
  const connection = tileConnection(status, replayComplete);
  const maxTiles = limits?.max_tiles ?? DEFAULT_MAX_TILES;
  const shown = sessions.slice(0, maxTiles * (1 + extraPages));
  const hiddenCount = sessions.length - shown.length;
  const nextBatch = Math.min(hiddenCount, maxTiles);
  const endedCount = sessions.filter((session) => isSessionEnded(session, isTerminal)).length;
  const liveCount = sessions.length - endedCount;
  const focusedSession = sessions.find((session) => session.id === focusedId) ?? null;
  const stepsErrorSession =
    openSteps.error === null
      ? undefined
      : sessions.find((session) => session.id === openSteps.error?.sessionId);
  const pausedByMotion = pauseChoice === null && reducedMotion && liveCount > 0;
  const announced = useThrottledValue(
    sessions.length === 0
      ? ""
      : `${liveCount} live browser ${liveCount === 1 ? "session" : "sessions"}, ${endedCount} ended`,
    TILE_ANNOUNCEMENT_INTERVAL_MS,
  );

  function focusSession(sessionId: string): void {
    setFocusedId(sessionId);
  }

  function openSessionSteps(session: TileSession): void {
    setFocusedId(null);
    void openSteps.open(session);
  }

  const waitingToStart = run?.status === "queued" || run?.status === "planning";
  const emptyDescription = waitingToStart
    ? "No tiles yet: the run has not started."
    : isTerminal
      ? "This run opened no browser session, so there is nothing to show here."
      : "No browser session is open. API-only runs never show tiles.";

  return (
    <section
      aria-labelledby={headingId}
      data-slot="tile-grid"
      data-run-id={runId}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-base font-semibold">
          Live tiles
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          {sessions.length > 0 ? (
            <p className="text-xs text-muted-foreground" data-slot="tile-summary">
              {liveCount} live, {endedCount} ended
            </p>
          ) : null}
          {liveCount > 0 && !isTerminal ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setPauseChoice(!paused)}
            >
              {paused ? (
                <Play aria-hidden="true" data-icon="inline-start" />
              ) : (
                <Pause aria-hidden="true" data-icon="inline-start" />
              )}
              {paused ? "Resume tiles" : "Pause all tiles"}
            </Button>
          ) : null}
        </div>
      </div>

      {pausedByMotion ? (
        <p className="text-xs text-muted-foreground">
          Tiles are paused because your system asks for reduced motion. Resume to watch live.
        </p>
      ) : null}

      {openSteps.error === null ? null : (
        <p role="alert" className="text-sm text-verdict-fail-fg">
          Could not open the steps
          {stepsErrorSession === undefined ? "" : ` of ${stepsErrorSession.title}`}:{" "}
          {openSteps.error.message}
        </p>
      )}

      {sessionsQuery.isPending && sessions.length === 0 ? (
        <div
          aria-busy="true"
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        >
          <span className="sr-only">Loading browser sessions</span>
          {SKELETON_TILES.map((tile) => (
            <Skeleton key={tile} className="aspect-[8/5] w-full rounded-xl" />
          ))}
        </div>
      ) : sessionsQuery.isError && sessions.length === 0 ? (
        <ErrorState
          title="Could not load browser sessions"
          description={describeApiError(sessionsQuery.error)}
          requestId={isApiError(sessionsQuery.error) ? sessionsQuery.error.requestId : null}
          onRetry={() => void sessionsQuery.refetch()}
          className="py-10"
        />
      ) : sessions.length === 0 ? (
        <EmptyState
          icon={MonitorOff}
          title="No browser sessions"
          description={emptyDescription}
          className="py-10"
        />
      ) : (
        <>
          {sessionsQuery.isError ? (
            <p role="alert" className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-verdict-fail-fg">
                The session list could not be refreshed: {describeApiError(sessionsQuery.error)}
              </span>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => void sessionsQuery.refetch()}
              >
                Retry
              </Button>
            </p>
          ) : null}
          <ul
            aria-label="Browser session tiles"
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
          >
            {shown.map((session) => (
              <li key={session.id} className="min-w-0">
                <ScreencastTile
                  session={session}
                  ended={isSessionEnded(session, isTerminal)}
                  frameBus={frameBus}
                  activity={activity}
                  connection={connection}
                  paused={paused}
                  focused={focusedId === session.id}
                  stepsPending={openSteps.pendingSessionId === session.id}
                  onFocus={focusSession}
                  onOpenSteps={openSessionSteps}
                />
              </li>
            ))}
          </ul>
          {hiddenCount > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="self-start"
              onClick={() => setExtraPages((pages) => pages + 1)}
            >
              {`Show ${nextBatch} more ${nextBatch === 1 ? "session" : "sessions"} (${hiddenCount} hidden)`}
            </Button>
          ) : null}
        </>
      )}

      <TileFocusDialog
        session={focusedSession}
        ended={focusedSession === null ? false : isSessionEnded(focusedSession, isTerminal)}
        frameBus={frameBus}
        activity={activity}
        connection={connection}
        stepsPending={focusedSession !== null && openSteps.pendingSessionId === focusedSession.id}
        onClose={() => setFocusedId(null)}
        onOpenSteps={openSessionSteps}
      />

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-slot="tile-live-region"
        className="sr-only"
      >
        {announced}
      </div>
    </section>
  );
}
