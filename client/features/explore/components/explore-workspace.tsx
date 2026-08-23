"use client";

import { useId } from "react";
import { RunKindList } from "@/features/runs/components/run-kind-list";
import { CurrentTargetGate } from "@/features/targets/current-target-gate";
import { ExploreForm } from "./explore-form";

function ExploreWorkspaceForTarget({ targetId }: { targetId: string }) {
  const formHeadingId = useId();
  return (
    <div data-slot="explore-workspace" className="flex flex-col gap-10">
      <section aria-labelledby={formHeadingId} className="flex max-w-3xl flex-col gap-4">
        <h2 id={formHeadingId} className="text-base font-semibold">
          Start an exploration
        </h2>
        <ExploreForm targetId={targetId} />
      </section>
      <RunKindList
        kind="explore"
        targetId={targetId}
        heading="Recent explorations"
        noun="exploration"
        emptyDescription="Start one above. It appears here the moment it is created, and you can open it to watch the browser live."
      />
    </div>
  );
}

export function ExploreWorkspace() {
  return (
    <CurrentTargetGate
      title="Choose a target to explore"
      description="An exploration drives a real browser against one target as one of its roles. Pick a target to start."
    >
      {(targetId) => <ExploreWorkspaceForTarget key={targetId} targetId={targetId} />}
    </CurrentTargetGate>
  );
}
