import { Braces, Brain, Scale, User } from "lucide-react";
import { StatusBadge, type StatusBadgeProps } from "./status-badge";
import type { VerdictTier } from "./status-types";

const tierPresentation = {
  code: { tone: "tier-code", label: "T0 Code", icon: Braces },
  laya: { tone: "tier-laya", label: "T1 Laya", icon: Brain },
  judge: { tone: "tier-judge", label: "T2 Judge", icon: Scale },
  human: { tone: "tier-human", label: "T3 Human", icon: User },
} as const satisfies Record<VerdictTier, Pick<StatusBadgeProps, "tone" | "label" | "icon">>;

export function TierBadge({
  tier,
  ...props
}: { tier: VerdictTier } & Omit<StatusBadgeProps, "tone" | "label" | "icon">) {
  return <StatusBadge {...tierPresentation[tier]} {...props} />;
}
