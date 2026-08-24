import { CircleDot, CircleHelp, TriangleAlert } from "lucide-react";
import { StatusBadge, type StatusBadgeProps } from "@/components/status/status-badge";
import type { ProbeStatus } from "@/lib/api/types";
import { PROBE_STATUS_LABELS } from "../probe-model";

export const PROBE_STATUS_PRESENTATION = {
  decided: { tone: "tier-laya", icon: CircleDot },
  uncertain: { tone: "verdict-uncertain", icon: CircleHelp },
  error: { tone: "severity-high", icon: TriangleAlert },
} as const satisfies Record<ProbeStatus, Pick<StatusBadgeProps, "tone" | "icon">>;

export function ProbeStatusChip({ status }: { status: ProbeStatus }) {
  return (
    <StatusBadge
      {...PROBE_STATUS_PRESENTATION[status]}
      label={PROBE_STATUS_LABELS[status]}
      data-probe-status={status}
    />
  );
}
