import {
  Eye,
  KeyRound,
  Pencil,
  Radio,
  Route as RouteIcon,
  ShieldCheck,
  Timer,
  type LucideIcon,
} from "lucide-react";
import { StatusBadge, type StatusBadgeProps } from "@/components/status/status-badge";
import { FEATURE_KIND_LABELS } from "../schemas";
import type { FeatureKind } from "../types";

const KIND_PRESENTATION: Record<FeatureKind, { tone: StatusBadgeProps["tone"]; icon: LucideIcon }> =
  {
    read: { tone: "hollow", icon: Eye },
    write: { tone: "severity-medium", icon: Pencil },
    flow: { tone: "hollow", icon: RouteIcon },
    auth: { tone: "hollow", icon: KeyRound },
    admin: { tone: "hollow", icon: ShieldCheck },
    stream: { tone: "hollow", icon: Radio },
    job: { tone: "hollow", icon: Timer },
  };

export function KindBadge({
  kind,
  ...props
}: { kind: FeatureKind } & Omit<StatusBadgeProps, "tone" | "label" | "icon">) {
  const presentation = KIND_PRESENTATION[kind];
  return (
    <StatusBadge
      data-kind={kind}
      tone={presentation.tone}
      icon={presentation.icon}
      label={FEATURE_KIND_LABELS[kind]}
      {...props}
    />
  );
}
