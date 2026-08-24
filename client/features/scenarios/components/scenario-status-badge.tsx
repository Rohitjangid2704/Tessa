import {
  Archive,
  Ban,
  CircleCheck,
  CircleX,
  Eye,
  FilePen,
  Loader,
  ShieldAlert,
} from "lucide-react";
import { StatusBadge, type StatusBadgeProps } from "@/components/status/status-badge";
import type { ScenarioStatus } from "@/lib/api/types";
import { SCENARIO_STATUS_LABELS } from "../labels";

const presentation = {
  draft: { tone: "hollow", icon: FilePen },
  validating: { tone: "verdict-skipped", icon: Loader },
  invalid: { tone: "verdict-fail", icon: CircleX },
  in_review: { tone: "verdict-flaky", icon: Eye },
  accepted: { tone: "verdict-pass", icon: CircleCheck },
  rejected: { tone: "verdict-fail", icon: Ban },
  quarantined: { tone: "verdict-flaky", icon: ShieldAlert },
  retired: { tone: "verdict-skipped", icon: Archive },
} as const satisfies Record<ScenarioStatus, Pick<StatusBadgeProps, "tone" | "icon">>;

const STATUS_HINTS: Partial<Record<ScenarioStatus, string>> = {
  quarantined: "Quarantined after repeated flaky results. Runs skip it with the reason quarantined.",
};

export function ScenarioStatusBadge({
  status,
  ...props
}: { status: ScenarioStatus } & Omit<StatusBadgeProps, "tone" | "label" | "icon">) {
  const { tone, icon } = presentation[status];
  return (
    <StatusBadge
      tone={tone}
      icon={icon}
      label={SCENARIO_STATUS_LABELS[status]}
      title={STATUS_HINTS[status]}
      {...props}
    />
  );
}
