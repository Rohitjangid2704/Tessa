import { CircleCheck, CircleHelp, CircleX, SkipForward, Shuffle } from "lucide-react";
import { StatusBadge, type StatusBadgeProps } from "./status-badge";
import type { VerdictStatus } from "./status-types";

const verdictPresentation = {
  pass: { tone: "verdict-pass", label: "Pass", icon: CircleCheck },
  fail: { tone: "verdict-fail", label: "Fail", icon: CircleX },
  flaky: { tone: "verdict-flaky", label: "Flaky", icon: Shuffle },
  uncertain: { tone: "verdict-uncertain", label: "Uncertain", icon: CircleHelp },
  skipped: { tone: "verdict-skipped", label: "Skipped", icon: SkipForward },
} as const satisfies Record<VerdictStatus, Pick<StatusBadgeProps, "tone" | "label" | "icon">>;

export function VerdictBadge({
  verdict,
  ...props
}: { verdict: VerdictStatus } & Omit<StatusBadgeProps, "tone" | "label" | "icon">) {
  return <StatusBadge {...verdictPresentation[verdict]} {...props} />;
}
