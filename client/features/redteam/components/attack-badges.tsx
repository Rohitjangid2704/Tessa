import {
  CircleCheck,
  CircleHelp,
  CircleMinus,
  CircleX,
  Hourglass,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestionMark,
} from "lucide-react";
import { StatusBadge, type StatusBadgeProps } from "@/components/status/status-badge";
import type { AttackOutcome } from "@/lib/api/types";
import { ATTACK_OUTCOME_LABELS, SKEPTIC_LABELS, type SkepticState } from "../labels";

const outcomePresentation = {
  blocked: { tone: "attack-blocked", icon: ShieldCheck },
  breached: { tone: "attack-breached", icon: ShieldAlert },
  inconclusive: { tone: "attack-inconclusive", icon: ShieldQuestionMark },
} as const satisfies Record<AttackOutcome, Pick<StatusBadgeProps, "tone" | "icon">>;

export function AttackOutcomeBadge({
  outcome,
  ...props
}: { outcome: AttackOutcome } & Omit<StatusBadgeProps, "tone" | "label" | "icon">) {
  return (
    <StatusBadge
      data-outcome={outcome}
      label={ATTACK_OUTCOME_LABELS[outcome]}
      {...outcomePresentation[outcome]}
      {...props}
    />
  );
}

const skepticPresentation = {
  not_needed: { tone: "hollow", icon: CircleMinus },
  pending: { tone: "live-reconnecting", icon: Hourglass },
  confirmed: { tone: "verdict-fail", icon: CircleX },
  not_confirmed: { tone: "verdict-pass", icon: CircleCheck },
  unsure: { tone: "verdict-uncertain", icon: CircleHelp },
} as const satisfies Record<SkepticState, Pick<StatusBadgeProps, "tone" | "icon">>;

export function SkepticBadge({
  state,
  ...props
}: { state: SkepticState } & Omit<StatusBadgeProps, "tone" | "label" | "icon">) {
  return (
    <StatusBadge
      data-skeptic={state}
      label={SKEPTIC_LABELS[state]}
      {...skepticPresentation[state]}
      {...props}
    />
  );
}
