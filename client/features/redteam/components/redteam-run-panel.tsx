"use client";

import { useQuery } from "@tanstack/react-query";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import type { RedTeamFamily } from "@/lib/api/types";
import { useHydrated } from "@/lib/use-hydrated";
import { mergeRoundViews, type LiveRound } from "../model";
import { REDTEAM_POLL_INTERVAL_MS, redteamFamiliesQuery, redteamRoundsQuery } from "../queries";
import { AttackList } from "./attack-list";
import { RoundsTimeline } from "./rounds-timeline";

const NO_LIVE_ROUNDS: readonly LiveRound[] = [];
const NO_FAMILIES: readonly RedTeamFamily[] = [];

export type RedteamRunPanelProps = {
  runId: string;
  runActive: boolean;
  liveRounds?: readonly LiveRound[];
  polling?: boolean;
};

export function RedteamRunPanel({
  runId,
  runActive,
  liveRounds = NO_LIVE_ROUNDS,
  polling = true,
}: RedteamRunPanelProps) {
  const hydrated = useHydrated();
  const pollMs = runActive && polling ? REDTEAM_POLL_INTERVAL_MS : false;
  const families = useQuery(redteamFamiliesQuery());
  const rounds = useQuery(redteamRoundsQuery(runId, pollMs));
  const familyList = families.data ?? NO_FAMILIES;
  const views = mergeRoundViews(rounds.data ?? [], liveRounds);

  function familyTitleOf(familyId: string): string {
    return familyList.find((family) => family.id === familyId)?.title ?? familyId;
  }

  function roundIndexOf(roundId: string): number | null {
    const match = views.find((round) => round.id === roundId);
    return match === undefined || match.index === 0 ? null : match.index;
  }

  const timeline =
    !hydrated || (rounds.isPending && liveRounds.length === 0) ? (
      <div role="status" aria-busy="true" className="flex flex-col gap-2">
        <span className="sr-only">Loading the rounds</span>
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-12 w-full" />
      </div>
    ) : rounds.isError && rounds.data === undefined && liveRounds.length === 0 ? (
      <ErrorState
        title="Could not load the rounds"
        description={describeApiError(rounds.error)}
        requestId={readRequestId(rounds.error)}
        onRetry={() => void rounds.refetch()}
      />
    ) : (
      <RoundsTimeline rounds={views} runActive={runActive} familyTitleOf={familyTitleOf} />
    );

  return (
    <div data-slot="redteam-run-panel" data-run-id={runId} className="flex flex-col gap-6">
      {timeline}
      <AttackList
        runId={runId}
        families={familyList}
        familyTitleOf={familyTitleOf}
        roundIndexOf={roundIndexOf}
        runActive={runActive}
        pollMs={pollMs}
      />
    </div>
  );
}
