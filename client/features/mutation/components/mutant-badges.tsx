import {
  Archive,
  CircleDashed,
  CircleX,
  LoaderCircle,
  Minus,
  Rocket,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { StatusBadge, type StatusBadgeProps } from "@/components/status/status-badge";
import { MUTANT_STATUS_LABELS, MUTATION_OUTCOME_LABELS } from "../schemas";
import type { MutantStatus, MutationOutcome } from "../types";

type BadgeProps = Omit<StatusBadgeProps, "tone" | "label" | "icon">;

const STATUS_PRESENTATION = {
  registered: { tone: "hollow", icon: CircleDashed },
  deployed: { tone: "live-live", icon: Rocket },
  retired: { tone: "verdict-skipped", icon: Archive },
} as const satisfies Record<MutantStatus, Pick<StatusBadgeProps, "tone" | "icon">>;

const OUTCOME_PRESENTATION = {
  killed: { tone: "verdict-pass", icon: ShieldCheck },
  survived: { tone: "kpi-warn", icon: TriangleAlert },
  errored: { tone: "verdict-fail", icon: CircleX },
  skipped: { tone: "verdict-skipped", icon: Minus },
} as const satisfies Record<MutationOutcome, Pick<StatusBadgeProps, "tone" | "icon">>;

export function MutantStatusBadge({ status, ...props }: { status: MutantStatus } & BadgeProps) {
  return (
    <StatusBadge
      {...STATUS_PRESENTATION[status]}
      label={MUTANT_STATUS_LABELS[status]}
      data-status={status}
      {...props}
    />
  );
}

export function MutationOutcomeBadge({
  outcome,
  ...props
}: { outcome: MutationOutcome | null } & BadgeProps) {
  if (outcome === null) {
    return <StatusBadge tone="hollow" icon={Minus} label="Not run" data-outcome="none" {...props} />;
  }
  return (
    <StatusBadge
      {...OUTCOME_PRESENTATION[outcome]}
      label={MUTATION_OUTCOME_LABELS[outcome]}
      data-outcome={outcome}
      {...props}
    />
  );
}

export function PendingOutcomeBadge(props: BadgeProps) {
  return (
    <StatusBadge
      tone="live-live"
      icon={LoaderCircle}
      label="Waiting"
      data-outcome="pending"
      {...props}
    />
  );
}
