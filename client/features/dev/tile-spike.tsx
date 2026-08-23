"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { describeApiError } from "@/lib/api/errors";
import { useStartFrameRun } from "./start-frame-run";
import { TileStream } from "./tile-stream";

const DEFAULT_SESSIONS = 12;
const MIN_SESSIONS = 1;
const MAX_SESSIONS = 24;

function clampSessions(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_SESSIONS;
  }
  return Math.min(MAX_SESSIONS, Math.max(MIN_SESSIONS, Math.trunc(value)));
}

export function TileSpike({
  autostart = false,
  initialSessions = DEFAULT_SESSIONS,
}: {
  autostart?: boolean;
  initialSessions?: number;
}) {
  const inputId = useId();
  const [sessionCount, setSessionCount] = useState(clampSessions(initialSessions));
  const [runId, setRunId] = useState<string | null>(null);
  const mutation = useStartFrameRun();
  const autostarted = useRef(false);
  const { mutate } = mutation;

  function start(count: number) {
    mutate(count, { onSuccess: (created) => setRunId(created.run_id) });
  }

  useEffect(() => {
    if (autostart && !autostarted.current) {
      autostarted.current = true;
      mutate(initialSessions, { onSuccess: (created) => setRunId(created.run_id) });
    }
  }, [autostart, initialSessions, mutate]);

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          start(sessionCount);
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={inputId}>Sessions</Label>
          <Input
            id={inputId}
            type="number"
            inputMode="numeric"
            min={MIN_SESSIONS}
            max={MAX_SESSIONS}
            value={sessionCount}
            className="w-24"
            onChange={(event) => setSessionCount(clampSessions(event.target.valueAsNumber))}
          />
        </div>
        <Button type="submit" disabled={mutation.isPending}>
          {runId === null ? "Start tiles" : "Restart tiles"}
        </Button>
      </form>
      {mutation.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Could not start the frame run</AlertTitle>
          <AlertDescription>{describeApiError(mutation.error)}</AlertDescription>
        </Alert>
      ) : null}
      {runId === null ? (
        <p className="text-sm text-muted-foreground">
          Starts a mock run with that many browser sessions and streams their frames over the run
          WebSocket.
        </p>
      ) : (
        <TileStream key={runId} runId={runId} />
      )}
    </div>
  );
}
