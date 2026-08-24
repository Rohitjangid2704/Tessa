import { Ban, CircleX, Clock, Flag, Play, SkipForward } from "lucide-react";
import { StatusBadge, type StatusBadgeProps } from "@/components/status/status-badge";
import type { RunScenarioStatus } from "@/lib/api/types";
import { RUN_SCENARIO_STATUS_LABELS } from "../labels";

const presentation = {
  queued: { tone: "hollow", icon: Clock },
  running: { tone: "live-live", icon: Play },
  finished: { tone: "verdict-skipped", icon: Flag },
  skipped: { tone: "verdict-skipped", icon: SkipForward },
  errored: { tone: "verdict-fail", icon: CircleX },
  canceled: { tone: "verdict-skipped", icon: Ban },
} as const satisfies Record<RunScenarioStatus, Pick<StatusBadgeProps, "tone" | "icon">>;

export function RunScenarioStatusBadge({
  status,
  ...props
}: { status: RunScenarioStatus } & Omit<StatusBadgeProps, "tone" | "label" | "icon">) {
  const { tone, icon } = presentation[status];
  return (
    <StatusBadge tone={tone} icon={icon} label={RUN_SCENARIO_STATUS_LABELS[status]} {...props} />
  );
}
