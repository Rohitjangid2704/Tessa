import { CircleCheck, CircleHelp, CircleX, Shuffle, SkipForward } from "lucide-react";
import { StatusBadge, type StatusBadgeProps } from "@/components/status/status-badge";
import type { VerdictStatus } from "@/lib/api/types";

const presentation = {
  fail: { tone: "verdict-fail", label: "Breaking", icon: CircleX },
  uncertain: { tone: "verdict-uncertain", label: "Uncertain", icon: CircleHelp },
  flaky: { tone: "verdict-flaky", label: "Unstable", icon: Shuffle },
  skipped: { tone: "verdict-skipped", label: "Not compared", icon: SkipForward },
  pass: { tone: "verdict-pass", label: "Compatible", icon: CircleCheck },
} as const satisfies Record<VerdictStatus, Pick<StatusBadgeProps, "tone" | "label" | "icon">>;

export function contractVerdictLabel(verdict: VerdictStatus): string {
  return presentation[verdict].label;
}

export function ContractVerdictBadge({
  verdict,
  ...props
}: { verdict: VerdictStatus } & Omit<StatusBadgeProps, "tone" | "label" | "icon">) {
  return <StatusBadge {...presentation[verdict]} {...props} />;
}
