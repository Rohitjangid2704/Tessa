import { ChevronsUp } from "lucide-react";
import type { ComponentProps } from "react";
import { StatusBadge } from "@/components/status/status-badge";
import { TierBadge } from "@/components/status/tier-badge";
import { VerdictBadge } from "@/components/status/verdict-badge";
import type { Verdict } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { formatConfidence, isEscalated } from "../format";

export function EscalatedMarker({ tier }: { tier: Verdict["tier"] }) {
  return (
    <StatusBadge
      tone="tier-judge"
      label="Escalated"
      icon={ChevronsUp}
      data-slot="escalated-marker"
      title={
        tier === "human"
          ? "Escalated past the probes and the judge to a human"
          : "Escalated past the Laya probes to the judge"
      }
    />
  );
}

export type VerdictChipsProps = {
  verdict: Verdict;
} & Omit<ComponentProps<"span">, "children">;

export function VerdictChips({ verdict, className, ...props }: VerdictChipsProps) {
  const confidence = formatConfidence(verdict.confidence);
  return (
    <span
      data-slot="verdict-chips"
      data-verdict={verdict.status}
      data-tier={verdict.tier}
      className={cn("inline-flex flex-wrap items-center gap-1.5", className)}
      {...props}
    >
      <VerdictBadge verdict={verdict.status} />
      <TierBadge tier={verdict.tier} />
      {confidence === null ? null : (
        <span
          data-slot="verdict-confidence"
          className="text-xs font-medium text-muted-foreground tabular-nums"
        >
          <span className="sr-only">Confidence </span>
          {confidence}
        </span>
      )}
      {isEscalated(verdict) ? <EscalatedMarker tier={verdict.tier} /> : null}
    </span>
  );
}
