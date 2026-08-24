import { Check, Circle, X } from "lucide-react";
import { StatusBadge, type StatusBadgeProps } from "@/components/status/status-badge";
import type { DependencyStatus } from "../dependencies";

const dependencyPresentation = {
  up: { tone: "verdict-pass", label: "Up", icon: Check },
  down: { tone: "verdict-fail", label: "Down", icon: X },
  unconfigured: { tone: "hollow", label: "Unconfigured", icon: Circle },
} as const satisfies Record<DependencyStatus, Pick<StatusBadgeProps, "tone" | "label" | "icon">>;

export function DependencyStatusBadge({
  status,
  ...props
}: { status: DependencyStatus } & Omit<StatusBadgeProps, "tone" | "label" | "icon">) {
  return <StatusBadge {...dependencyPresentation[status]} {...props} />;
}
