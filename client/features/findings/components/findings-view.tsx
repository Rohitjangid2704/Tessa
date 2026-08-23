"use client";

import { CurrentTargetGate } from "@/features/targets/current-target-gate";
import { Board } from "./board";

export function FindingsView() {
  return (
    <CurrentTargetGate
      title="Choose a target"
      description="Findings belong to one target. Pick a target to triage the findings of its runs."
    >
      {(targetId) => <Board key={targetId} targetId={targetId} />}
    </CurrentTargetGate>
  );
}
