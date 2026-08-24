"use client";

import { ArrowLeftRight, ChevronDown, TriangleAlert } from "lucide-react";
import { TierBadge } from "@/components/status/tier-badge";
import { VerdictBadge } from "@/components/status/verdict-badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { JsonView } from "@/features/steps/components/json-view";
import type { JudgeResult, Step } from "@/lib/api/types";
import { formatUsd } from "@/lib/format-usd";
import { clampUnit, formatUnit } from "../probe-model";
import {
  isStubJudge,
  JUDGE_FAMILY_LABELS,
  judgeSection,
  judgeUsedTiebreak,
} from "../tier-ladder-model";
import { LabelFlow } from "./label-flow";
import { StepSection } from "./step-section";
import { StubModelMarker } from "./stub-model-marker";

function PairwiseNote({ judge }: { judge: JudgeResult }) {
  const pairwise = judge.pairwise;
  if (pairwise === null) {
    return (
      <p data-slot="judge-pairwise" data-swapped-agrees="none" className="text-sm">
        Single pass: no reference answer existed, so the presentation order was not swapped.
      </p>
    );
  }
  if (pairwise.swapped_agrees) {
    return (
      <p
        data-slot="judge-pairwise"
        data-swapped-agrees="true"
        className="flex items-start gap-1.5 text-sm"
      >
        <ArrowLeftRight aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>
          Swapped order agrees (swapped_agrees true): both presentation orders gave one verdict.
        </span>
      </p>
    );
  }
  return (
    <p
      data-slot="judge-pairwise"
      data-swapped-agrees="false"
      className="flex items-start gap-1.5 text-sm"
    >
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>
        Swapped order disagrees (swapped_agrees false): the two presentation orders gave different
        verdicts.{" "}
        {judgeUsedTiebreak(judge)
          ? `The tie-break model ${JUDGE_FAMILY_LABELS[judge.family]} ${judge.model} decided.`
          : "No tie-break settled it, so the verdict stays uncertain."}
      </span>
    </p>
  );
}

function JudgeVerdict({ judge }: { judge: JudgeResult }) {
  const { verdict } = judge;
  return (
    <div data-slot="judge-verdict" className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <VerdictBadge verdict={verdict.status} />
        <TierBadge tier={verdict.tier} />
        {verdict.confidence === null ? null : (
          <span className="text-sm tabular-nums">
            Confidence {formatUnit(clampUnit(verdict.confidence).value)}
          </span>
        )}
        {verdict.reason_code === null ? null : (
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
            {verdict.reason_code}
          </code>
        )}
      </div>
      {verdict.reason === null ? null : (
        <p data-slot="judge-reason" className="text-sm wrap-break-word">
          {verdict.reason}
        </p>
      )}
    </div>
  );
}

function JudgeFacts({ judge }: { judge: JudgeResult }) {
  const stub = isStubJudge(judge);
  return (
    <dl
      data-slot="judge-facts"
      className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm"
    >
      <dt className="text-muted-foreground">Family</dt>
      <dd data-slot="judge-family">
        {JUDGE_FAMILY_LABELS[judge.family]}
        {judgeUsedTiebreak(judge) ? " (tie-break)" : ""}
      </dd>
      <dt className="text-muted-foreground">Model</dt>
      <dd data-slot="judge-model" className="font-mono text-xs wrap-anywhere">
        {judge.model}
      </dd>
      <dt className="text-muted-foreground">Effort</dt>
      <dd data-slot="judge-effort">{judge.effort}</dd>
      <dt className="text-muted-foreground">Rubric version</dt>
      <dd data-slot="judge-rubric" className="font-mono text-xs">
        {judge.rubric_version}
      </dd>
      <dt className="text-muted-foreground">Cost</dt>
      <dd data-slot="judge-cost" className="tabular-nums">
        {formatUsd(judge.cost_usd)}
        {stub ? " (stub models never call a provider)" : ""}
      </dd>
    </dl>
  );
}

function JudgeResultPanel({ step, judge }: { step: Step; judge: JudgeResult }) {
  const stub = isStubJudge(judge);

  return (
    <StepSection title="LLM judge">
      <div
        data-slot="judge-panel"
        data-state="ran"
        data-stub={stub}
        className="flex flex-col gap-3"
      >
        {stub ? <StubModelMarker className="self-start" /> : null}
        <JudgeVerdict judge={judge} />
        <JudgeFacts judge={judge} />
        <PairwiseNote judge={judge} />
        <LabelFlow
          step={step}
          subjectType="judge_result"
          subjectId={judge.id}
          actionLabel="Judge is wrong"
        />
        <Collapsible data-slot="judge-raw">
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="group">
              Raw judge JSON
              <ChevronDown
                aria-hidden="true"
                data-icon="inline-end"
                className="transition-transform group-aria-expanded:rotate-180"
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2">
            <JsonView value={judge} label="Judge result JSON" />
          </CollapsibleContent>
        </Collapsible>
      </div>
    </StepSection>
  );
}

const ABSENCE_COPY = {
  not_needed: {
    title: "Not needed",
    body: "The Laya probes decided every question, so no judge ran and no judge cost was spent.",
  },
  did_not_run: {
    title: "Did not run",
    body: "Not every probe was decided, but no judge result is stored for this step.",
  },
} as const;

function JudgeAbsencePanel({ kind }: { kind: keyof typeof ABSENCE_COPY }) {
  const copy = ABSENCE_COPY[kind];

  return (
    <StepSection title={`LLM judge: ${copy.title.toLowerCase()}`}>
      <p data-slot="judge-panel" data-state={kind} className="text-sm text-muted-foreground">
        {copy.body}
      </p>
    </StepSection>
  );
}

export function JudgePanel({ step }: { step: Step }) {
  if (step.judge !== null) {
    return <JudgeResultPanel step={step} judge={step.judge} />;
  }
  const section = judgeSection(step);
  if (section === "not_needed" || section === "did_not_run") {
    return <JudgeAbsencePanel kind={section} />;
  }
  return null;
}
