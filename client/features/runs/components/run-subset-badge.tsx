import { ListFilter } from "lucide-react";
import { StatusBadge } from "@/components/status/status-badge";
import type { Run } from "@/lib/api/types";
import { subsetScenarioIds } from "../run-subset";

export function RunSubsetBadge({ run }: { run: Run }) {
  const ids = subsetScenarioIds(run);
  if (ids === null) {
    return null;
  }
  const noun = ids.length === 1 ? "scenario" : "scenarios";
  return (
    <span data-slot="run-subset" className="inline-flex flex-wrap items-center gap-2">
      <StatusBadge
        tone="hollow"
        label={`Subset: ${ids.length} ${noun}`}
        icon={ListFilter}
        title="Only the listed scenarios ran; this run is not a full pass"
      />
      <span className="text-sm text-muted-foreground">Invariants and API fuzz skipped</span>
    </span>
  );
}
