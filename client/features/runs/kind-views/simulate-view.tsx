"use client";

import { SimLive } from "@/features/simulators/components/sim-live";
import { EventLog } from "../components/event-log";

export type SimulateViewProps = { runId: string };

export function SimulateView({ runId }: SimulateViewProps) {
  return (
    <div data-slot="simulate-view" className="flex flex-col gap-6">
      <SimLive key={runId} runId={runId} />
      <EventLog runId={runId} />
    </div>
  );
}
