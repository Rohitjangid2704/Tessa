import { FlaskConical, ShieldAlert } from "lucide-react";
import { StatusBadge, type StatusBadgeProps } from "@/components/status/status-badge";
import { TARGET_TIER_LABELS } from "../app-kinds";
import type { TargetTier } from "../types";

export type TierChipProps = { tier: TargetTier } & Omit<
  StatusBadgeProps,
  "tone" | "label" | "icon"
>;

export function TierChip({ tier, ...props }: TierChipProps) {
  if (tier === "production") {
    return (
      <StatusBadge
        tone="tier-production"
        label={TARGET_TIER_LABELS.production}
        icon={ShieldAlert}
        data-tier="production"
        {...props}
      />
    );
  }
  return (
    <StatusBadge
      tone="hollow"
      label={TARGET_TIER_LABELS.qa}
      icon={FlaskConical}
      data-tier="qa"
      {...props}
    />
  );
}
