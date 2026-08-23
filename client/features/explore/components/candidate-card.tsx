"use client";

import { useQuery } from "@tanstack/react-query";
import {
  CircleCheck,
  CircleHelp,
  CircleSlash,
  LoaderCircle,
  Search,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { StatusBadge } from "@/components/status/status-badge";
import type { Tone } from "@/components/status/tones";
import { Button } from "@/components/ui/button";
import { runScenarioQuery } from "@/features/runs/queries";
import { findingRoutes, runRoutes } from "@/lib/routes";
import type { CandidateRow, CandidateState } from "../model";

interface CandidatePresentation {
  tone: Tone;
  label: string;
  icon: LucideIcon;
}

const CANDIDATE_PRESENTATION = {
  verifying: { tone: "live-reconnecting", label: "Possible issue, verifying", icon: LoaderCircle },
  confirmed: { tone: "verdict-fail", label: "Confirmed finding", icon: CircleCheck },
  not_reproduced: { tone: "verdict-skipped", label: "Could not reproduce", icon: CircleSlash },
  dropped: { tone: "hollow", label: "Not verified, the run ended first", icon: CircleHelp },
} as const satisfies Record<CandidateState, CandidatePresentation>;

export function describeActionRange(candidate: Pick<CandidateRow, "fromIndex" | "toIndex">) {
  return candidate.fromIndex === candidate.toIndex
    ? `Action ${candidate.fromIndex + 1}`
    : `Actions ${candidate.fromIndex + 1} to ${candidate.toIndex + 1}`;
}

export type CandidateCardProps = {
  runId: string;
  candidate: CandidateRow;
};

function useFirstReplayStepId(replayRunScenarioId: string | null): string | null {
  const replay = useQuery({
    ...runScenarioQuery(replayRunScenarioId ?? ""),
    enabled: replayRunScenarioId !== null,
    select: (row) => row.steps[0]?.id ?? null,
  });
  return replay.data ?? null;
}

export function CandidateCard({ runId, candidate }: CandidateCardProps) {
  const presentation = CANDIDATE_PRESENTATION[candidate.state];
  const firstReplayStepId = useFirstReplayStepId(candidate.replayRunScenarioId);
  return (
    <li
      data-slot="candidate-card"
      data-state={candidate.state}
      data-candidate-id={candidate.candidateId}
      className="flex flex-col gap-2 rounded-xl border p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={presentation.tone} label={presentation.label} icon={presentation.icon} />
        <span className="text-xs text-muted-foreground">{describeActionRange(candidate)}</span>
      </div>
      <p className="text-sm wrap-break-word">{candidate.description}</p>
      <div className="flex flex-wrap items-center gap-2">
        {candidate.state === "confirmed" && candidate.findingId !== null ? (
          <Button asChild size="sm" variant="outline">
            <Link href={findingRoutes.detail(candidate.findingId)}>
              <Search aria-hidden="true" data-icon="inline-start" />
              Open the finding
            </Link>
          </Button>
        ) : null}
        {firstReplayStepId === null ? null : (
          <Button asChild size="sm" variant="ghost">
            <Link href={runRoutes.step(runId, firstReplayStepId)} scroll={false}>
              Open the replay steps
            </Link>
          </Button>
        )}
        {candidate.state === "verifying" ? (
          <span className="text-xs text-muted-foreground">
            Replaying the steps to see whether it happens again
          </span>
        ) : null}
      </div>
    </li>
  );
}
