"use client";

import {
  CircleAlert,
  CircleStop,
  Clock,
  Hourglass,
  LoaderCircle,
  Maximize2,
  MonitorOff,
  Pause,
  Radio,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { StatusBadge } from "@/components/status/status-badge";
import type { Tone } from "@/components/status/tones";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useNow } from "@/lib/use-now";
import type { FrameBus } from "@/lib/ws/frame-bus";
import { ScreencastCanvas } from "@/lib/ws/screencast-canvas";
import { useTileActivity, type TileActivityStore } from "../tile-activity";
import { previewSize, type TileSession } from "../tile-sessions";
import {
  DIMMED_TILE_STATES,
  STALE_CHECK_INTERVAL_MS,
  deriveTileState,
  type TileConnection,
  type TileState,
} from "../tile-state";

export const GRID_PREVIEW_WIDTH = 640;

interface TileStatePresentation {
  tone: Tone;
  label: string;
  icon: LucideIcon;
}

const TILE_STATE_PRESENTATION = {
  live: { tone: "live-live", label: "Live", icon: Radio },
  waiting: { tone: "live-closed", label: "Waiting for first frame", icon: Hourglass },
  stale: { tone: "live-reconnecting", label: "Stale", icon: Clock },
  paused: { tone: "live-closed", label: "Paused", icon: Pause },
  connecting: { tone: "live-reconnecting", label: "Connecting", icon: LoaderCircle },
  reconnecting: { tone: "live-reconnecting", label: "Reconnecting", icon: WifiOff },
  offline: { tone: "live-error", label: "Live view offline", icon: CircleAlert },
  ended: { tone: "live-closed", label: "Ended", icon: CircleStop },
} as const satisfies Record<TileState, TileStatePresentation>;

export function tileAspectRatio(session: TileSession): string {
  return `${session.viewport.width} / ${session.viewport.height}`;
}

export function attemptLabel(session: TileSession): string {
  return `attempt ${session.attempt + 1}`;
}

export function TileStatusBadge({ state, className }: { state: TileState; className?: string }) {
  return (
    <StatusBadge
      data-tile-status={state}
      className={className}
      {...TILE_STATE_PRESENTATION[state]}
    />
  );
}

export function TileCaption({
  session,
  pageUrl,
}: {
  session: TileSession;
  pageUrl: string | null;
}) {
  return (
    <div data-slot="tile-caption" className="flex flex-col gap-0.5 px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="truncate text-sm font-medium" title={session.title}>
          {session.title}
        </p>
        <span className="shrink-0 text-xs text-muted-foreground">
          Attempt {session.attempt + 1}
        </span>
      </div>
      <p
        data-slot="tile-page-url"
        className="truncate font-mono text-xs text-muted-foreground"
        title={pageUrl ?? undefined}
      >
        {pageUrl ?? "No page reported yet"}
      </p>
    </div>
  );
}

export function describeEndedSession(session: TileSession): string {
  const saved = [session.hasRecording ? "recording" : null, session.hasTrace ? "trace" : null]
    .filter((item): item is string => item !== null)
    .join(" and ");
  return saved === "" ? "Session ended" : `Session ended, ${saved} saved`;
}

export function EndedPlaceholder({
  session,
  stepsPending,
  onOpenSteps,
  className,
}: {
  session: TileSession;
  stepsPending: boolean;
  onOpenSteps: (session: TileSession) => void;
  className?: string;
}) {
  return (
    <div
      data-slot="tile-ended-placeholder"
      style={{ aspectRatio: tileAspectRatio(session) }}
      className={cn(
        "flex flex-col items-center justify-center gap-2 bg-muted px-3 text-center text-muted-foreground",
        className,
      )}
    >
      <MonitorOff aria-hidden="true" className="size-6" />
      <TileStatusBadge state="ended" />
      <p className="text-xs">{describeEndedSession(session)}</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={stepsPending}
        aria-label={`Open steps for ${session.title}, ${attemptLabel(session)}`}
        onClick={() => onOpenSteps(session)}
      >
        {stepsPending ? (
          <LoaderCircle
            aria-hidden="true"
            data-icon="inline-start"
            className="animate-spin motion-reduce:animate-none"
          />
        ) : null}
        Open steps
      </Button>
    </div>
  );
}

export type ScreencastTileProps = {
  session: TileSession;
  ended: boolean;
  frameBus: FrameBus;
  activity: TileActivityStore;
  connection: TileConnection;
  paused: boolean;
  focused: boolean;
  stepsPending: boolean;
  onFocus: (sessionId: string) => void;
  onOpenSteps: (session: TileSession) => void;
};

export function ScreencastTile({ ended, ...props }: ScreencastTileProps) {
  if (ended) {
    return <EndedTile {...props} />;
  }
  return <LiveTile {...props} />;
}

type TileBodyProps = Omit<ScreencastTileProps, "ended">;

function EndedTile({ session, stepsPending, onOpenSteps }: TileBodyProps) {
  return (
    <Card
      data-slot="screencast-tile"
      data-state="ended"
      data-session-id={session.id}
      className="gap-0 overflow-hidden p-0"
    >
      <EndedPlaceholder session={session} stepsPending={stepsPending} onOpenSteps={onOpenSteps} />
      <TileCaption session={session} pageUrl={session.lastUrl} />
    </Card>
  );
}

function LiveTile({
  session,
  frameBus,
  activity,
  connection,
  paused,
  focused,
  onFocus,
}: TileBodyProps) {
  const frameActivity = useTileActivity(activity, session.id);
  const now = useNow(STALE_CHECK_INTERVAL_MS);
  const state = deriveTileState({
    ended: false,
    connection,
    paused,
    lastFrameAt: frameActivity?.lastFrameAt ?? null,
    now,
  });
  const size = previewSize(session.viewport, GRID_PREVIEW_WIDTH);
  const pageUrl = frameActivity?.pageUrl ?? session.lastUrl;

  return (
    <Card
      data-slot="screencast-tile"
      data-state={state}
      data-session-id={session.id}
      className="gap-0 overflow-hidden p-0"
    >
      <div className="relative bg-muted">
        {focused ? (
          <div
            style={{ aspectRatio: tileAspectRatio(session) }}
            className="flex items-center justify-center text-xs text-muted-foreground"
          >
            Shown in the focus view
          </div>
        ) : (
          <ScreencastCanvas
            bus={frameBus}
            sessionId={session.id}
            label={`Live view of ${session.title}, ${attemptLabel(session)}`}
            paused={paused}
            width={size.width}
            height={size.height}
            onFrame={(frame) => activity.record(session.id, frame, Date.now())}
            className={cn(DIMMED_TILE_STATES.includes(state) && "opacity-60")}
          />
        )}
        <TileStatusBadge state={state} className="absolute top-2 left-2" />
        <Button
          type="button"
          variant="secondary"
          size="icon-sm"
          className="absolute top-2 right-2"
          title="Focus view"
          aria-label={`Open focus view of ${session.title}, ${attemptLabel(session)}`}
          onClick={() => onFocus(session.id)}
        >
          <Maximize2 aria-hidden="true" />
        </Button>
      </div>
      <TileCaption session={session} pageUrl={pageUrl} />
    </Card>
  );
}
