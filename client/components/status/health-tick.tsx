import { Check, Circle, Minus, X } from "lucide-react";
import { StatusBadge, type StatusBadgeProps } from "./status-badge";
import type { HealthStatus } from "./status-types";

const healthPresentation = {
  ok: { tone: "verdict-pass", label: "OK", icon: Check },
  failed: { tone: "verdict-fail", label: "Failed", icon: X },
  skipped: { tone: "verdict-skipped", label: "Skipped", icon: Minus },
  unchecked: { tone: "hollow", label: "Unchecked", icon: Circle },
} as const satisfies Record<HealthStatus, Pick<StatusBadgeProps, "tone" | "label" | "icon">>;

export function HealthTick({
  status,
  ...props
}: { status: HealthStatus } & Omit<StatusBadgeProps, "tone" | "label" | "icon">) {
  return <StatusBadge {...healthPresentation[status]} {...props} />;
}
