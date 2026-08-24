"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useId } from "react";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DbChecksPanel } from "@/features/steps/components/db-checks-panel";
import { EvidenceViewer } from "@/features/steps/components/evidence-viewer";
import { GoldPointsPanel } from "@/features/steps/components/gold-points-panel";
import { JudgePanel } from "@/features/steps/components/judge-panel";
import { ProbePanel } from "@/features/steps/components/probe-panel";
import { TierLadder } from "@/features/steps/components/tier-ladder";
import { sameId } from "@/features/steps/format";
import { isStepNotFound, stepQuery } from "@/features/steps/queries";
import { useArtifactRefresh, type StepRefetch } from "@/features/steps/use-artifact-refresh";
import type { Step } from "@/lib/api/types";
import { CardsView } from "./cards-view";
import { JsonView } from "./json-view";
import { RequestSection } from "./request-section";
import { ResponseSection } from "./response-section";
import { StepHeader } from "./step-header";
import { StepMedia } from "./step-media";
import { StepSection } from "./step-section";
import {
  BackToRun,
  StepLoadError,
  StepNotFound,
  StepSkeleton,
  type StepInspectorVariant,
} from "./step-states";
import { Tier0Failures } from "./tier0-failures";
import { ToolsList } from "./tools-list";

export type StepInspectorProps = {
  stepId: string;
  variant: StepInspectorVariant;
  runId?: string;
};

function withoutArtifactLinks(step: Step) {
  return {
    ...step,
    artifacts: step.artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      mime: artifact.mime,
      size_bytes: artifact.size_bytes,
      expires_at: artifact.expires_at,
    })),
  };
}

function RawStepSection({ step }: { step: Step }) {
  return (
    <StepSection title="Raw step">
      <Collapsible className="flex flex-col gap-2">
        <CollapsibleTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="group self-start">
            <ChevronRight
              aria-hidden="true"
              className="transition-transform group-aria-expanded:rotate-90 motion-reduce:transition-none"
              data-icon="inline-start"
            />
            Show the step as JSON
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Signed artifact links are left out so the copy is safe to paste into a report.
          </p>
          <JsonView value={withoutArtifactLinks(step)} label="Raw step JSON" defaultOpenDepth={1} />
        </CollapsibleContent>
      </Collapsible>
    </StepSection>
  );
}

interface StepContentProps {
  step: Step;
  headingId: string;
  variant: StepInspectorVariant;
  runId: string | undefined;
  refetch: StepRefetch;
}

function StepContent({ step, headingId, variant, runId, refetch }: StepContentProps) {
  const refresh = useArtifactRefresh(step.artifacts, refetch);

  return (
    <>
      {variant === "page" ? <BackToRun runId={runId ?? step.run_id} /> : null}
      <StepHeader step={step} headingId={headingId} variant={variant} />
      <RequestSection step={step} />
      <ResponseSection step={step} />
      <StepMedia step={step} refresh={refresh} />
      <Tier0Failures tier0={step.tier0} />
      <GoldPointsPanel step={step} />
      <DbChecksPanel step={step} />
      <TierLadder step={step} />
      <ProbePanel step={step} />
      <JudgePanel step={step} />
      <EvidenceViewer step={step} />
      <ToolsList tools={step.tools} />
      <CardsView cards={step.cards} />
      <RawStepSection step={step} />
    </>
  );
}

function UnavailableHeading({ id, variant }: { id: string; variant: StepInspectorVariant }) {
  const Heading = variant === "page" ? "h1" : "h2";
  return (
    <Heading id={id} className="sr-only">
      Step details
    </Heading>
  );
}

export function StepInspector({ stepId, variant, runId }: StepInspectorProps) {
  const headingId = useId();
  const query = useQuery(stepQuery(stepId));
  const step = query.data;
  const belongsHere = step === undefined || runId === undefined || sameId(step.run_id, runId);

  function renderBody() {
    if (step !== undefined && belongsHere) {
      return (
        <StepContent
          key={step.id}
          step={step}
          headingId={headingId}
          variant={variant}
          runId={runId}
          refetch={query.refetch}
        />
      );
    }
    if (step !== undefined) {
      return <StepNotFound runId={runId} variant={variant} />;
    }
    if (query.isError) {
      return isStepNotFound(query.error) ? (
        <StepNotFound runId={runId} variant={variant} requestId={readRequestId(query.error)} />
      ) : (
        <StepLoadError
          error={query.error}
          runId={runId}
          variant={variant}
          onRetry={() => void query.refetch()}
        />
      );
    }
    return <StepSkeleton />;
  }

  return (
    <section
      aria-labelledby={headingId}
      data-slot="step-inspector"
      data-variant={variant}
      className="flex min-w-0 flex-col gap-6"
    >
      {step !== undefined && belongsHere ? null : (
        <UnavailableHeading id={headingId} variant={variant} />
      )}
      {renderBody()}
    </section>
  );
}
