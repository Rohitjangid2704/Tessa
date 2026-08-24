import { CircleCheck, CircleX, Hourglass } from "lucide-react";
import { StatusBadge, type StatusBadgeProps } from "@/components/status/status-badge";
import type { ReplayRecordStatus } from "@/lib/api/types";
import { REPLAY_RECORD_STATUS_LABELS } from "../labels";

const presentation = {
  pending: { tone: "hollow", icon: Hourglass },
  created: { tone: "tier-code", icon: CircleCheck },
  rejected: { tone: "verdict-flaky", icon: CircleX },
} as const satisfies Record<ReplayRecordStatus, Pick<StatusBadgeProps, "tone" | "icon">>;

export function ReplayRecordBadge({
  status,
  ...props
}: { status: ReplayRecordStatus } & Omit<StatusBadgeProps, "tone" | "label" | "icon">) {
  return (
    <StatusBadge
      data-status={status}
      label={REPLAY_RECORD_STATUS_LABELS[status]}
      {...presentation[status]}
      {...props}
    />
  );
}
