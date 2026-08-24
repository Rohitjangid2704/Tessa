"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useNow } from "@/lib/use-now";
import type { FrameBus } from "@/lib/ws/frame-bus";
import { ScreencastCanvas } from "@/lib/ws/screencast-canvas";
import { useTileActivity, type TileActivityStore } from "../tile-activity";
import { previewSize, type TileSession } from "../tile-sessions";
import { STALE_CHECK_INTERVAL_MS, deriveTileState, type TileConnection } from "../tile-state";
import { EndedPlaceholder, TileStatusBadge, attemptLabel } from "./screencast-tile";

export const FOCUS_PREVIEW_WIDTH = 1280;

export type TileFocusDialogProps = {
  session: TileSession | null;
  ended: boolean;
  frameBus: FrameBus;
  activity: TileActivityStore;
  connection: TileConnection;
  stepsPending: boolean;
  onClose: () => void;
  onOpenSteps: (session: TileSession) => void;
};

type FocusContentProps = Omit<TileFocusDialogProps, "session" | "onClose"> & {
  session: TileSession;
};

export function TileFocusDialog({ session, onClose, ...content }: TileFocusDialogProps) {
  return (
    <Dialog
      open={session !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      {session === null ? null : <FocusContent session={session} {...content} />}
    </Dialog>
  );
}

function FocusContent({
  session,
  ended,
  frameBus,
  activity,
  connection,
  stepsPending,
  onOpenSteps,
}: FocusContentProps) {
  const frameActivity = useTileActivity(activity, session.id);
  const now = useNow(STALE_CHECK_INTERVAL_MS);
  const state = deriveTileState({
    ended,
    connection,
    paused: false,
    lastFrameAt: frameActivity?.lastFrameAt ?? null,
    now,
  });
  const size = previewSize(session.viewport, FOCUS_PREVIEW_WIDTH);
  const pageUrl = frameActivity?.pageUrl ?? session.lastUrl;

  return (
    <DialogContent
      data-slot="tile-focus-dialog"
      data-tile-state={state}
      className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-5xl"
    >
      <DialogHeader>
        <DialogTitle>{session.title}</DialogTitle>
        <DialogDescription>
          Focus view, {attemptLabel(session)}.{" "}
          <span className="font-mono text-xs break-all">{pageUrl ?? "No page reported yet"}</span>
        </DialogDescription>
      </DialogHeader>
      <div className="relative overflow-hidden rounded-lg bg-muted">
        {ended ? (
          <EndedPlaceholder
            session={session}
            stepsPending={stepsPending}
            onOpenSteps={onOpenSteps}
          />
        ) : (
          <>
            <ScreencastCanvas
              bus={frameBus}
              sessionId={session.id}
              mode="focus"
              label={`Focus view of ${session.title}, ${attemptLabel(session)}`}
              width={size.width}
              height={size.height}
              onFrame={(frame) => activity.record(session.id, frame, Date.now())}
              className="mx-auto h-auto max-h-[65dvh] w-auto max-w-full"
            />
            <TileStatusBadge state={state} className="absolute top-2 left-2" />
          </>
        )}
      </div>
      <DialogFooter showCloseButton>
        {ended ? null : (
          <Button
            type="button"
            variant="outline"
            disabled={stepsPending}
            onClick={() => onOpenSteps(session)}
          >
            Open steps
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  );
}
