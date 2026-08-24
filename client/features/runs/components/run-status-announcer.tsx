"use client";

import { useThrottledValue } from "@/lib/use-throttled-value";
import { describeConnection, describeRunAnnouncement } from "../connection";
import { useRunStreamState } from "../use-run-stream";

export const ANNOUNCEMENT_INTERVAL_MS = 2000;

export function RunStatusAnnouncer() {
  const { run, status, isTerminal } = useRunStreamState();
  const connection = describeConnection({ status, isTerminal });
  const message = run === undefined ? "" : describeRunAnnouncement(run.status, connection);
  const announced = useThrottledValue(message, ANNOUNCEMENT_INTERVAL_MS);
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-slot="run-live-region"
      className="sr-only"
    >
      {announced}
    </div>
  );
}
