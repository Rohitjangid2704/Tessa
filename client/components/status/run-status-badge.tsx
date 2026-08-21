import {
  Ban,
  CircleX,
  Clock,
  Flag,
  ListChecks,
  Play,
  Sprout,
  TriangleAlert,
  Wallet,
} from "lucide-react";
import { StatusBadge, type StatusBadgeProps } from "./status-badge";
import type { RunStatus } from "./status-types";

const runStatusPresentation = {
  queued: { tone: "verdict-skipped", label: "Queued", icon: Clock },
  planning: { tone: "verdict-skipped", label: "Planning", icon: ListChecks },
  seeding: { tone: "verdict-skipped", label: "Seeding", icon: Sprout },
  running: { tone: "live-live", label: "Running", icon: Play },
  canceling: { tone: "verdict-flaky", label: "Canceling", icon: TriangleAlert },
  completed: { tone: "verdict-skipped", label: "Completed", icon: Flag },
  failed: { tone: "verdict-fail", label: "Failed", icon: CircleX },
  canceled: { tone: "verdict-skipped", label: "Canceled", icon: Ban },
  budget_exceeded: { tone: "verdict-flaky", label: "Budget exceeded", icon: Wallet },
} as const satisfies Record<RunStatus, Pick<StatusBadgeProps, "tone" | "label" | "icon">>;

export function RunStatusBadge({
  status,
  ...props
}: { status: RunStatus } & Omit<StatusBadgeProps, "tone" | "label" | "icon">) {
  return <StatusBadge {...runStatusPresentation[status]} {...props} />;
}
