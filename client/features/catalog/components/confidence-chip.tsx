import { CircleAlert, CircleCheck, CircleHelp, type LucideIcon } from "lucide-react";
import { StatusBadge, type StatusBadgeProps } from "@/components/status/status-badge";
import { CONFIDENCE_LABELS } from "../schemas";
import type { Confidence } from "../types";

const CONFIDENCE_PRESENTATION: Record<
  Confidence,
  { tone: StatusBadgeProps["tone"]; icon: LucideIcon }
> = {
  high: { tone: "verdict-pass", icon: CircleCheck },
  medium: { tone: "verdict-flaky", icon: CircleHelp },
  low: { tone: "verdict-uncertain", icon: CircleAlert },
};

export function ConfidenceChip({
  confidence,
  ...props
}: { confidence: Confidence } & Omit<StatusBadgeProps, "tone" | "label" | "icon">) {
  const presentation = CONFIDENCE_PRESENTATION[confidence];
  return (
    <StatusBadge
      data-confidence={confidence}
      tone={presentation.tone}
      icon={presentation.icon}
      label={`${CONFIDENCE_LABELS[confidence]} confidence`}
      {...props}
    />
  );
}
