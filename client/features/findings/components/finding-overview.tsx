"use client";

import Link from "next/link";
import { DateTime } from "@/components/date-time";
import { Button } from "@/components/ui/button";
import {
  FactList,
  StepSection,
  type Fact,
} from "@/features/steps/components/step-section";
import { TruncatedText } from "@/features/steps/components/text-view";
import type { Finding } from "@/lib/api/types";
import { runRoutes, scenarioHref } from "@/lib/routes";
import { FINDING_CLASS_LABELS, shortId } from "../detail-schemas";
import { FindingControls } from "./finding-controls";
import { TicketLinkField } from "./ticket-link-field";
import { ValueView } from "./value-view";

export const LATEST_EXPLANATION_PREVIEW_CHARACTERS = 600;

export interface FindingOverviewProps {
  finding: Finding;
  onOpenExplanations: () => void;
}

function RunLink({ runId }: { runId: string }) {
  return (
    <Link href={runRoutes.detail(runId)} className="text-primary underline underline-offset-4">
      Run {shortId(runId)}
    </Link>
  );
}

function summaryFacts(finding: Finding): Fact[] {
  const facts: Fact[] = [
    { label: "Class", value: FINDING_CLASS_LABELS[finding.class] },
    {
      label: "Invariant",
      value: finding.invariant_id ?? "None, this is not tied to an invariant",
      mono: finding.invariant_id !== null,
    },
    { label: "Fingerprint", value: finding.fingerprint, mono: true },
    { label: "Occurrences", value: String(finding.occurrence_count) },
    {
      label: "First seen",
      value: (
        <span className="flex flex-wrap items-center gap-x-2">
          <DateTime value={finding.first_seen_at} />
          <RunLink runId={finding.first_seen_run_id} />
        </span>
      ),
    },
    {
      label: "Last seen",
      value: (
        <span className="flex flex-wrap items-center gap-x-2">
          <DateTime value={finding.last_seen_at} />
          <RunLink runId={finding.last_seen_run_id} />
        </span>
      ),
    },
  ];
  if (finding.promoted_scenario_id !== null) {
    facts.push({
      label: "Promoted to",
      value: (
        <Link
          href={scenarioHref(finding.promoted_scenario_id)}
          className="text-primary underline underline-offset-4"
        >
          Scenario {shortId(finding.promoted_scenario_id)}
        </Link>
      ),
    });
  }
  return facts;
}

export function FindingOverview({ finding, onOpenExplanations }: FindingOverviewProps) {
  return (
    <div data-slot="finding-overview" className="flex flex-col gap-6">
      <FindingControls finding={finding} />
      <StepSection title="Ticket">
        <TicketLinkField finding={finding} />
      </StepSection>
      <StepSection title="Summary">
        <FactList facts={summaryFacts(finding)} />
      </StepSection>
      <StepSection title="Expected and actual">
        <div className="grid gap-3 md:grid-cols-2">
          <ValueView value={finding.expected} label="Expected" />
          <ValueView value={finding.actual} label="Actual" />
        </div>
      </StepSection>
      {finding.latest_explanation === null ? null : (
        <StepSection
          title="Latest explanation"
          actions={
            <Button type="button" variant="link" size="xs" onClick={onOpenExplanations}>
              See all explanations
            </Button>
          }
        >
          <p className="text-sm">
            <TruncatedText
              text={finding.latest_explanation.text}
              limit={LATEST_EXPLANATION_PREVIEW_CHARACTERS}
            />
          </p>
        </StepSection>
      )}
    </div>
  );
}
