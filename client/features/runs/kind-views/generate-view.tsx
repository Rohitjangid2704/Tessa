"use client";

import { EventLog } from "../components/event-log";
import { GenerateProgress } from "./generate-progress";

export type GenerateViewProps = { runId: string };

export function GenerateView({ runId }: GenerateViewProps) {
  return (
    <div data-slot="generate-view" className="flex flex-col gap-6">
      <GenerateProgress />
      <EventLog runId={runId} />
    </div>
  );
}
