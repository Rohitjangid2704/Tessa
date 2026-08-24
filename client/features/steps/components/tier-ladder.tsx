"use client";

import {
  ArrowDown,
  Ban,
  CircleDot,
  Hourglass,
  Minus,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { TierBadge } from "@/components/status/tier-badge";
import { VerdictBadge } from "@/components/status/verdict-badge";
import type { Step } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { clampUnit, formatUnit } from "../probe-model";
import {
  buildTierLadder,
  RUNG_OUTCOME_LABELS,
  type LadderRung,
  type RungOutcome,
  type TierLadderModel,
} from "../tier-ladder-model";
import { LabelFlow } from "./label-flow";
import { StepSection } from "./step-section";
import { StubModelMarker } from "./stub-model-marker";

const OUTCOME_ICONS: Record<RungOutcome, LucideIcon> = {
  decided: CircleDot,
  handed_on: ArrowDown,
  not_needed: Minus,
  not_run: Ban,
  awaiting_label: UserRound,
  pending: Hourglass,
};

const IDLE_OUTCOMES: readonly RungOutcome[] = ["not_needed", "not_run", "pending"];

interface RungItemProps {
  step: Step;
  model: TierLadderModel;
  rung: LadderRung;
}

function RungItem({ step, model, rung }: RungItemProps) {
  const Icon = OUTCOME_ICONS[rung.outcome];
  const idle = IDLE_OUTCOMES.includes(rung.outcome);

  return (
    <li
      data-slot="ladder-rung"
      data-tier={rung.tier}
      data-outcome={rung.outcome}
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border p-3",
        rung.outcome === "decided" && "border-foreground/40 bg-muted/40",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <TierBadge tier={rung.tier} />
        <span className="text-sm font-medium">{rung.heading}</span>
        <span
          data-slot="rung-outcome"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground"
        >
          <Icon aria-hidden="true" className="size-3.5 shrink-0" />
          {RUNG_OUTCOME_LABELS[rung.outcome]}
        </span>
        {rung.tier === "judge" && model.stub ? <StubModelMarker compact /> : null}
      </div>
      <p
        data-slot="rung-detail"
        className={cn("text-sm wrap-break-word", idle && "text-muted-foreground")}
      >
        {rung.detail}
      </p>
      {rung.tier === "human" ? (
        <LabelFlow
          step={step}
          subjectType="step"
          subjectId={step.id}
          actionLabel={model.needsHuman ? "Set the verdict" : null}
        />
      ) : null}
    </li>
  );
}

function OriginLine({ model }: { model: TierLadderModel }) {
  const { verdict } = model;
  if (verdict === null) {
    return (
      <p role="status" data-slot="ladder-origin" data-graded="false" className="text-sm">
        Not graded yet. The grade appears here as soon as the run reports it.
      </p>
    );
  }
  return (
    <div
      role="status"
      data-slot="ladder-origin"
      data-graded="true"
      className="flex flex-wrap items-center gap-2 text-sm"
    >
      <span className="text-muted-foreground">The verdict came from</span>
      <TierBadge tier={verdict.tier} />
      <VerdictBadge verdict={verdict.status} />
      {verdict.confidence === null ? null : (
        <span className="tabular-nums">
          confidence {formatUnit(clampUnit(verdict.confidence).value)}
        </span>
      )}
      <span data-slot="ladder-escalation" className="flex items-center gap-1 text-muted-foreground">
        {model.escalatedTo === null ? (
          "No escalation"
        ) : (
          <>
            Escalated to <TierBadge tier={model.escalatedTo} />
          </>
        )}
      </span>
    </div>
  );
}

export function TierLadder({ step }: { step: Step }) {
  const model = buildTierLadder(step);

  return (
    <StepSection title="Grading tiers">
      <div
        data-slot="tier-ladder"
        data-graded={model.graded}
        data-decided-by={model.decidedBy ?? "none"}
        className="flex flex-col gap-3"
      >
        <OriginLine model={model} />
        <ol aria-label="Tiers in order" className="flex flex-col gap-2">
          {model.rungs.map((rung) => (
            <RungItem key={rung.tier} step={step} model={model} rung={rung} />
          ))}
        </ol>
        {model.reasons.length === 0 ? null : (
          <div data-slot="ladder-reasons" className="flex flex-col gap-1">
            <h4 className="text-sm font-medium">Why it escalated</h4>
            <ul className="flex list-disc flex-col gap-0.5 pl-5 text-sm text-muted-foreground">
              {model.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </StepSection>
  );
}
