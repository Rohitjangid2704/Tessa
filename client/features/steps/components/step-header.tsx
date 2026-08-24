"use client";

import { CircleDashed, ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { DateTime } from "@/components/date-time";
import { StatusBadge } from "@/components/status/status-badge";
import { TierBadge } from "@/components/status/tier-badge";
import { VerdictBadge } from "@/components/status/verdict-badge";
import { Button } from "@/components/ui/button";
import { AdapterChip } from "@/features/adapters/components/adapter-chip";
import { isKnownAdapterKind, payloadKindOf } from "@/features/adapters/registry";
import { formatLatency } from "@/features/steps/format";
import type { Step, Verdict } from "@/lib/api/types";
import { formatUsd } from "@/lib/format-usd";
import { runRoutes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import type { StepInspectorVariant } from "./step-states";

export interface StepHeaderProps {
  step: Step;
  headingId: string;
  variant: StepInspectorVariant;
}

function VerdictSummary({ verdict }: { verdict: Verdict | null }) {
  if (verdict === null) {
    return <StatusBadge tone="hollow" label="Not graded yet" icon={CircleDashed} />;
  }
  return (
    <>
      <VerdictBadge verdict={verdict.status} />
      <TierBadge tier={verdict.tier} />
    </>
  );
}

function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{children}</dd>
    </div>
  );
}

function OpenFullPage({ step }: { step: Step }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => window.location.assign(runRoutes.step(step.run_id, step.id))}
    >
      Open full page
      <ExternalLink aria-hidden="true" data-icon="inline-end" />
    </Button>
  );
}

function payloadKindBesidesAdapter(step: Step): string | null {
  const payloadKind = payloadKindOf(step.request) ?? payloadKindOf(step.response);
  if (payloadKind === null || payloadKind === step.adapter || !isKnownAdapterKind(payloadKind)) {
    return null;
  }
  return payloadKind;
}

export function StepHeader({ step, headingId, variant }: StepHeaderProps) {
  const Heading = variant === "page" ? "h1" : "h2";
  const reason = step.verdict?.reason ?? null;
  const payloadKind = payloadKindBesidesAdapter(step);

  return (
    <header
      data-slot="step-header"
      className={cn("flex flex-col gap-3", variant === "drawer" && "pr-10")}
    >
      <Heading id={headingId} className="text-lg leading-snug font-semibold wrap-anywhere">
        {step.label}
      </Heading>
      <div className="flex flex-wrap items-center gap-2">
        <AdapterChip kind={step.adapter} />
        {payloadKind === null ? null : <AdapterChip kind={payloadKind} />}
        <VerdictSummary verdict={step.verdict} />
      </div>
      {reason === null ? null : (
        <p data-slot="verdict-reason" className="text-sm text-muted-foreground">
          {reason}
        </p>
      )}
      <dl data-slot="step-meta" className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <MetaItem label="Step index">{step.index}</MetaItem>
        <MetaItem label="Attempt">{step.attempt + 1}</MetaItem>
        <MetaItem label="Latency">{formatLatency(step.latency_ms)}</MetaItem>
        <MetaItem label="Cost">{formatUsd(step.cost_usd)}</MetaItem>
        <MetaItem label="Recorded">
          <DateTime value={step.started_at} />
        </MetaItem>
      </dl>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="inline-flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          Step ID <code className="font-mono">{step.id}</code>
          <CopyButton text={step.id} subject="step id" variant="ghost" size="xs" />
        </p>
        {variant === "drawer" ? <OpenFullPage step={step} /> : null}
      </div>
    </header>
  );
}
