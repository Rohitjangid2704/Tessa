"use client";

import { ExploreLive } from "@/features/explore/components/explore-live";
import { EventLog } from "../components/event-log";

export type ExploreViewProps = { runId: string };

export function ExploreView({ runId }: ExploreViewProps) {
  return (
    <div data-slot="explore-view" className="flex flex-col gap-6">
      <ExploreLive runId={runId} />
      <EventLog runId={runId} />
    </div>
  );
}
