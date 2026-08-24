"use client";

import { EventLog } from "../components/event-log";

export type DefaultViewProps = { runId: string };

export function DefaultView({ runId }: DefaultViewProps) {
  return (
    <div data-slot="default-run-view" className="flex flex-col gap-6">
      <EventLog runId={runId} />
    </div>
  );
}
