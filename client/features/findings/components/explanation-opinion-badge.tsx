import { Bug, CircleHelp, ClipboardX, Wrench } from "lucide-react";
import { StatusBadge, type StatusBadgeProps } from "@/components/status/status-badge";
import type { ExplanationOpinion } from "@/lib/api/types";

export const EXPLANATION_OPINION_PRESENTATION = {
  app_bug: { tone: "verdict-fail", label: "App bug", icon: Bug },
  scenario_bug: { tone: "verdict-flaky", label: "Scenario bug", icon: ClipboardX },
  harness: { tone: "severity-info", label: "Harness", icon: Wrench },
  unknown: { tone: "verdict-skipped", label: "Unknown", icon: CircleHelp },
} as const satisfies Record<ExplanationOpinion, Pick<StatusBadgeProps, "tone" | "label" | "icon">>;

export function ExplanationOpinionBadge({
  opinion,
  ...props
}: { opinion: ExplanationOpinion } & Omit<StatusBadgeProps, "tone" | "label" | "icon">) {
  return (
    <StatusBadge
      data-slot="explanation-opinion"
      data-opinion={opinion}
      {...EXPLANATION_OPINION_PRESENTATION[opinion]}
      {...props}
    />
  );
}
