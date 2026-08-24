import {
  ArrowDown,
  Ban,
  Circle,
  CircleAlert,
  CircleCheck,
  FilePen,
  ShieldCheck,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { StatusBadge, type StatusBadgeProps } from "@/components/status/status-badge";
import { PROPOSAL_RISK_LABELS, PROPOSAL_STATUS_LABELS } from "../labels";
import type { ProposalItemStatus, ProposalRisk } from "../types";

const RISK_PRESENTATION: Record<
  ProposalRisk,
  { tone: StatusBadgeProps["tone"]; icon: LucideIcon }
> = {
  high: { tone: "severity-high", icon: TriangleAlert },
  medium: { tone: "severity-medium", icon: CircleAlert },
  low: { tone: "severity-low", icon: ArrowDown },
};

const STATUS_PRESENTATION: Record<
  ProposalItemStatus,
  { tone: StatusBadgeProps["tone"]; icon: LucideIcon }
> = {
  proposed: { tone: "hollow", icon: Circle },
  selected: { tone: "kpi-good", icon: CircleCheck },
  declined: { tone: "verdict-skipped", icon: Ban },
  authored: { tone: "tier-human", icon: FilePen },
  covered: { tone: "verdict-pass", icon: ShieldCheck },
};

export function RiskBadge({
  risk,
  ...props
}: { risk: ProposalRisk } & Omit<StatusBadgeProps, "tone" | "label" | "icon">) {
  const presentation = RISK_PRESENTATION[risk];
  return (
    <StatusBadge
      data-risk={risk}
      tone={presentation.tone}
      icon={presentation.icon}
      label={PROPOSAL_RISK_LABELS[risk]}
      {...props}
    />
  );
}

export function ItemStatusBadge({
  status,
  ...props
}: { status: ProposalItemStatus } & Omit<StatusBadgeProps, "tone" | "label" | "icon">) {
  const presentation = STATUS_PRESENTATION[status];
  return (
    <StatusBadge
      data-item-status={status}
      tone={presentation.tone}
      icon={presentation.icon}
      label={PROPOSAL_STATUS_LABELS[status]}
      {...props}
    />
  );
}
