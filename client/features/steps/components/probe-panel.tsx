"use client";

import { Badge } from "@/components/ui/badge";
import { useProbeBank } from "@/features/probes/queries";
import type { Probe, ProbeEngine, ProbeResult, Step } from "@/lib/api/types";
import { formatUsd } from "@/lib/format-usd";
import { formatLatency } from "../format";
import {
  ANSWER_TYPE_LABELS,
  describeProbeSummary,
  groupProbesByPack,
  PACK_LABELS,
  summarizeProbes,
} from "../probe-model";
import { ConfidenceBar } from "./confidence-bar";
import { LabelFlow } from "./label-flow";
import { ProbeLegend } from "./probe-legend";
import { ProbeStatusChip } from "./probe-status-chip";
import { StepSection } from "./step-section";

const ENGINE_LABELS: Record<ProbeEngine, string> = { laya: "Laya", jev: "Jev" };

interface ProbeRowProps {
  step: Step;
  result: ProbeResult;
  probe: Probe | undefined;
}

function ProbeRow({ step, result, probe }: ProbeRowProps) {
  return (
    <li
      data-slot="probe-row"
      data-probe-id={result.probe_id}
      data-status={result.status}
      className="flex flex-col gap-2 rounded-lg border p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p data-slot="probe-question" className="text-sm font-medium wrap-break-word">
          {result.question}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <ProbeStatusChip status={result.status} />
          <Badge variant="outline" data-slot="probe-engine" data-engine={result.engine}>
            Engine {ENGINE_LABELS[result.engine]}
          </Badge>
        </div>
      </div>
      <p data-slot="probe-answer" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="text-muted-foreground">Answer</span>
        {result.answer === null ? (
          <span className="text-muted-foreground">none, the call failed</span>
        ) : (
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs wrap-anywhere">
            {result.answer}
          </code>
        )}
        {probe === undefined ? null : (
          <span className="text-xs text-muted-foreground">
            {ANSWER_TYPE_LABELS[probe.answer_type]} question
          </span>
        )}
      </p>
      <ConfidenceBar
        value={result.confidence}
        threshold={result.threshold}
        status={result.status}
        label={`Confidence of probe ${result.probe_id}`}
      />
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <div className="flex gap-1">
          <dt>Latency</dt>
          <dd data-slot="probe-latency" className="font-medium text-foreground tabular-nums">
            {formatLatency(result.latency_ms)}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt>Probe bank</dt>
          <dd data-slot="probe-bank-version" className="font-medium text-foreground tabular-nums">
            {result.probe_bank_version}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt>Probe</dt>
          <dd className="font-mono wrap-anywhere text-foreground">{result.probe_id}</dd>
        </div>
      </dl>
      <LabelFlow
        step={step}
        subjectType="probe_result"
        subjectId={result.id}
        actionLabel="Probe is wrong"
      />
    </li>
  );
}

function ProbePanelBody({ step }: { step: Step }) {
  const bank = useProbeBank();
  const summary = summarizeProbes(step.probes);
  const groups = groupProbesByPack(step.probes);
  const free = step.probes.every((result) => result.engine === "laya");

  return (
    <StepSection title="Laya probes">
      <div data-slot="probe-panel" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <p data-slot="probe-summary" className="text-sm text-muted-foreground">
            {describeProbeSummary(summary)}; {formatLatency(summary.latencyMs)} in total
            {free ? `; cost ${formatUsd(0)}` : ""}
          </p>
          <p className="text-xs text-muted-foreground">
            A probe answer is not a verdict. The verdict comes from the tier ladder.
          </p>
        </div>
        <ProbeLegend results={step.probes} />
        {groups.map((group) => (
          <div key={group.pack} data-pack={group.pack}>
            <h4 className="mb-2 text-sm font-medium text-muted-foreground">
              {PACK_LABELS[group.pack]}
            </h4>
            <ul aria-label={`${PACK_LABELS[group.pack]} results`} className="flex flex-col gap-3">
              {group.results.map((result) => (
                <ProbeRow
                  key={result.id}
                  step={step}
                  result={result}
                  probe={bank.byId.get(result.probe_id)}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </StepSection>
  );
}

export function ProbePanel({ step }: { step: Step }) {
  if (step.probes.length === 0) {
    return null;
  }
  return <ProbePanelBody step={step} />;
}
