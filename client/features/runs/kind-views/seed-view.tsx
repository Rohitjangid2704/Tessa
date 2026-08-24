"use client";

import { EventLog } from "../components/event-log";
import { RunBody, type RunBodySection } from "../components/run-body";
import { SeedRunPanel } from "../components/seed-run-panel";

const SEED_VIEW_SECTIONS: readonly RunBodySection[] = [
  {
    id: "seed",
    label: "Seed",
    span: "half",
    render: (runId) => <SeedRunPanel runId={runId} />,
  },
  {
    id: "events",
    label: "Events",
    span: "half",
    render: (runId) => <EventLog runId={runId} />,
  },
];

export type SeedViewProps = { runId: string };

export function SeedView({ runId }: SeedViewProps) {
  return <RunBody runId={runId} sections={SEED_VIEW_SECTIONS} />;
}
