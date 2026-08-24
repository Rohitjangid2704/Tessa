import { FlaskConical, ShieldAlert } from "lucide-react";
import { StatusBadge, type StatusBadgeProps } from "@/components/status/status-badge";
import { TARGET_TIER_LABELS } from "../app-kinds";
import type { TargetTier } from "../types";

export function TargetTierBadge({
  tier,
  ...props
}: { tier: TargetTier } & Omit<StatusBadgeProps, "tone" | "label" | "icon">) {
  if (tier === "production") {
    return (
      <StatusBadge
        tone="severity-critical-solid"
        label={TARGET_TIER_LABELS.production}
        icon={ShieldAlert}
        {...props}
      />
    );
  }
  return <StatusBadge tone="hollow" label={TARGET_TIER_LABELS.qa} icon={FlaskConical} {...props} />;
}
