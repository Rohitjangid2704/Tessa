"use client";

import { CircleMinus, Hourglass, LoaderCircle, ShieldAlert } from "lucide-react";
import { useId } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { pluralize } from "@/features/bundles/format";
import { useThrottledValue } from "@/lib/use-throttled-value";
import { cn } from "@/lib/utils";
import { DRY_ROUNDS_TO_STOP, roundLabel } from "../labels";
import {
  countTrailingDry,
  describeRoundsAnnouncement,
  isStoppingForDryRounds,
  type RoundView,
} from "../model";

export const ROUNDS_ANNOUNCEMENT_INTERVAL_MS = 2000;

export type RoundsTimelineProps = {
  rounds: readonly RoundView[];
  runActive: boolean;
  familyTitleOf: (familyId: string) => string;
};

function RoundState({ round }: { round: RoundView }) {
  if (!round.finished) {
    return (
      <span className="flex items-center gap-1 text-sm text-live-live-fg">
        <LoaderCircle
          aria-hidden="true"
          className="size-4 animate-spin motion-reduce:animate-none"
        />
        In progress
      </span>
    );
  }
  if (round.dry) {
    return (
      <span className="flex items-center gap-1 text-sm text-muted-foreground">
        <CircleMinus aria-hidden="true" className="size-4" />
        Dry: nothing got through
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-sm font-medium text-attack-breached-fg">
      <ShieldAlert aria-hidden="true" className="size-4" />
      {pluralize(round.candidates, "candidate")} to check
    </span>
  );
}

export function RoundsTimeline({ rounds, runActive, familyTitleOf }: RoundsTimelineProps) {
  const headingId = useId();
  const dryInARow = countTrailingDry(rounds);
  const stopping = isStoppingForDryRounds(rounds, runActive);
  const announced = useThrottledValue(
    describeRoundsAnnouncement(rounds),
    ROUNDS_ANNOUNCEMENT_INTERVAL_MS,
  );

  return (
    <section
      aria-labelledby={headingId}
      data-slot="rounds-timeline"
      data-dry-count={dryInARow}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-base font-semibold">
          Rounds
        </h2>
        <p data-slot="dry-counter" className="text-sm text-muted-foreground">
          Dry rounds in a row: {dryInARow} of {DRY_ROUNDS_TO_STOP}
        </p>
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {announced}
      </p>
      {stopping ? (
        <Alert data-slot="dry-stopping">
          <Hourglass aria-hidden="true" />
          <AlertTitle>Two dry rounds, stopping</AlertTitle>
          <AlertDescription>
            The last {DRY_ROUNDS_TO_STOP} rounds found nothing new, so the run is finishing.
          </AlertDescription>
        </Alert>
      ) : null}
      {rounds.length === 0 ? (
        <p data-slot="rounds-empty" className="text-sm text-muted-foreground">
          {runActive ? "Waiting for the first round to start." : "This run did not start any round."}
        </p>
      ) : (
        <ol aria-label="Red team rounds" className="flex flex-col gap-2">
          {rounds.map((round) => (
            <li
              key={round.id}
              data-slot="round"
              data-round-id={round.id}
              data-finished={round.finished}
              data-dry={round.dry}
              className={cn(
                "flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border px-3 py-2",
                !round.finished && "border-live-live-fg/40",
              )}
            >
              <span className="text-sm font-medium">{roundLabel(round.index)}</span>
              <span className="text-sm">{familyTitleOf(round.family)}</span>
              <span className="text-sm text-muted-foreground">
                {pluralize(round.attacks, "attack")}
              </span>
              <span className="ml-auto">
                <RoundState round={round} />
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
