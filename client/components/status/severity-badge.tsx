import { ArrowDown, CircleAlert, Info, OctagonAlert, TriangleAlert } from "lucide-react";
import { StatusBadge, type StatusBadgeProps } from "./status-badge";
import type { Severity } from "./status-types";

const severityPresentation = {
  critical: { tone: "severity-critical-solid", label: "Critical", icon: OctagonAlert },
  high: { tone: "severity-high", label: "High", icon: TriangleAlert },
  medium: { tone: "severity-medium", label: "Medium", icon: CircleAlert },
  low: { tone: "severity-low", label: "Low", icon: ArrowDown },
  info: { tone: "severity-info", label: "Info", icon: Info },
} as const satisfies Record<Severity, Pick<StatusBadgeProps, "tone" | "label" | "icon">>;

export function SeverityBadge({
  severity,
  ...props
}: { severity: Severity } & Omit<StatusBadgeProps, "tone" | "label" | "icon">) {
  return <StatusBadge {...severityPresentation[severity]} {...props} />;
}
