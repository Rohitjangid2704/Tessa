"use client";

import { MutationRunView } from "@/features/mutation/components/mutation-run-view";
import { EventLog } from "../components/event-log";

export type MutationViewProps = { runId: string };

export function MutationView({ runId }: MutationViewProps) {
  return (
    <div data-slot="mutation-view" className="flex flex-col gap-6">
      <MutationRunView runId={runId} />
      <EventLog runId={runId} />
    </div>
  );
}
