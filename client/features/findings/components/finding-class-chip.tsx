import { Shuffle } from "lucide-react";
import { StatusBadge } from "@/components/status/status-badge";
import { Badge } from "@/components/ui/badge";
import type { FindingClass } from "@/lib/api/types";
import { FINDING_CLASS_LABELS } from "../detail-schemas";

export const FLAKY_CLASS_HINT =
  "Filed automatically because the same scenario flipped between pass and fail across attempts or runs";

export function FindingClassChip({ findingClass }: { findingClass: FindingClass }) {
  if (findingClass === "flaky") {
    return (
      <StatusBadge
        data-slot="finding-class-chip"
        data-class={findingClass}
        tone="verdict-flaky"
        icon={Shuffle}
        label={FINDING_CLASS_LABELS.flaky}
        title={FLAKY_CLASS_HINT}
      />
    );
  }
  return (
    <Badge data-slot="finding-class-chip" data-class={findingClass} variant="outline">
      {FINDING_CLASS_LABELS[findingClass]}
    </Badge>
  );
}
