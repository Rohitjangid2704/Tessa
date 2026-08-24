"use client";

import { useId } from "react";
import { RunKindList } from "@/features/runs/components/run-kind-list";
import { useUrlFilters } from "@/lib/url-state";
import { readSessionId, simulatorsCodec } from "../schemas";
import { SessionSheet } from "./session-sheet";
import { SessionsTable } from "./sessions-table";
import { SimulationForm } from "./simulation-form";

export interface SimulationsPanelProps {
  targetId: string;
}

export function SimulationsPanel({ targetId }: SimulationsPanelProps) {
  const startHeadingId = useId();
  const filters = useUrlFilters(simulatorsCodec);
  const sessionId = readSessionId(filters.values.session);

  return (
    <div data-slot="simulations-panel" className="flex flex-col gap-8">
      <section aria-labelledby={startHeadingId} className="flex flex-col gap-3">
        <h2 id={startHeadingId} className="text-base font-semibold">
          Start a simulation
        </h2>
        <SimulationForm
          targetId={targetId}
          onCreate={(tab) => filters.setFilters({ tab }, { history: "push" })}
        />
      </section>
      <RunKindList
        kind="simulate"
        targetId={targetId}
        heading="Simulation runs"
        noun="simulation run"
        emptyDescription="Start a simulation above. Its run opens a live view with the conversation and the five checks."
      />
      <SessionsTable
        targetId={targetId}
        onOpen={(id) => filters.setFilters({ session: id }, { history: "push" })}
      />
      <SessionSheet
        sessionId={sessionId}
        targetId={targetId}
        onClose={() => filters.setFilters({ session: undefined }, { history: "push" })}
      />
    </div>
  );
}
