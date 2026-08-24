"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Hourglass, MessagesSquare } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "@/components/states/empty-state";
import { StatusBadge } from "@/components/status/status-badge";
import { VerdictBadge } from "@/components/status/verdict-badge";
import { Transcript, type TranscriptEntry } from "@/components/transcript";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useRunEvents, useRunStreamState } from "@/features/runs/use-run-stream";
import { simSessionsQuery } from "../queries";
import { deriveAttempts, phaseOf, type LiveAttempt } from "../sim-run-state";
import { useSimulatorNames } from "../use-simulator-names";
import { ChecksStrip, PassKStrip } from "./checks-strip";
import { SessionSheet, speakerLabel, speakerSide } from "./session-sheet";

export const SESSIONS_REFETCH_MS = 4000;
export const PREVIEW_ELLIPSIS = "…";

function previewEntries(attempt: LiveAttempt, personaName: string | null): TranscriptEntry[] {
  return attempt.turns.map((turn) => ({
    key: turn.key,
    speaker: speakerLabel(turn.speaker, personaName),
    side: speakerSide(turn.speaker),
    text: turn.preview,
    note: turn.preview.endsWith(PREVIEW_ELLIPSIS)
      ? "Preview. Open the full conversation for the whole text."
      : undefined,
  }));
}

interface AttemptCardProps {
  attempt: LiveAttempt;
  runEnded: boolean;
  open: boolean;
  personaName: string | null;
  onOpenSession: (sessionId: string) => void;
}

function AttemptState({ attempt, runEnded }: Pick<AttemptCardProps, "attempt" | "runEnded">) {
  const phase = phaseOf(attempt, runEnded);
  if (phase === "checked" && attempt.checked !== null) {
    return <VerdictBadge verdict={attempt.checked.verdict.status} />;
  }
  if (phase === "stopped") {
    return <StatusBadge tone="hollow" label="Ended without a result" icon={Hourglass} />;
  }
  return <StatusBadge tone="live-live" label="In conversation" icon={MessagesSquare} />;
}

function AttemptCard({ attempt, runEnded, open, personaName, onOpenSession }: AttemptCardProps) {
  const { checked } = attempt;
  return (
    <details
      open={open}
      data-slot="sim-attempt"
      data-attempt={attempt.attempt}
      className="rounded-xl border"
    >
      <summary className="flex cursor-pointer flex-wrap items-center gap-3 px-4 py-3 text-sm font-medium">
        <span>Attempt {attempt.attempt + 1}</span>
        <AttemptState attempt={attempt} runEnded={runEnded} />
        <span className="text-xs font-normal text-muted-foreground">
          {attempt.turns.length} {attempt.turns.length === 1 ? "message" : "messages"}
        </span>
      </summary>
      <div className="flex flex-col gap-3 px-4 pb-4">
        <Transcript
          label={`Messages of attempt ${attempt.attempt + 1}`}
          entries={previewEntries(attempt, personaName)}
          emptyText="Waiting for the first message."
          listClassName="max-h-72"
        />
        {checked === null ? null : (
          <div className="flex flex-col gap-3">
            {checked.verdict.reason === null ? null : (
              <p className="text-sm text-muted-foreground">{checked.verdict.reason}</p>
            )}
            <ChecksStrip checks={checked.checks} />
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onOpenSession(attempt.sessionId)}
              >
                Read the full conversation
              </Button>
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

function announcementOf(attempts: readonly LiveAttempt[]): string {
  const lastChecked = attempts.findLast((attempt) => attempt.checked !== null);
  if (lastChecked?.checked === undefined || lastChecked.checked === null) {
    return "";
  }
  return `Attempt ${lastChecked.attempt + 1} was checked: ${lastChecked.checked.verdict.status}.`;
}

export interface SimLiveProps {
  runId: string;
}

export function SimLive({ runId }: SimLiveProps) {
  const { run, isTerminal } = useRunStreamState();
  const { events, loaded } = useRunEvents();
  const sessions = useInfiniteQuery({
    ...simSessionsQuery({ runId }),
    refetchInterval: isTerminal ? false : SESSIONS_REFETCH_MS,
  });
  const targetId = run?.target_id ?? null;
  const names = useSimulatorNames(targetId);
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);

  const attempts = deriveAttempts(events);
  const firstSession = sessions.data?.items[0];
  const personaName = firstSession === undefined ? null : names.personaName(firstSession.persona_id);
  const goalTitle = firstSession === undefined ? null : names.goalTitle(firstSession.goal_id);
  const plannedAttempts = Math.max(run?.counters.scenarios_total ?? 0, attempts.length);
  const verdicts = Array.from(
    { length: plannedAttempts },
    (_, index) => attempts[index]?.checked?.verdict.status ?? null,
  );

  return (
    <section
      data-slot="sim-live"
      aria-label="Simulated user conversations"
      className="flex flex-col gap-4"
    >
      <p role="status" className="sr-only">
        {announcementOf(attempts)}
      </p>
      <Card>
        <CardHeader>
          <CardTitle>Simulated user</CardTitle>
          <CardDescription>
            {personaName === null || goalTitle === null
              ? "The persona and the goal show here once the first attempt has been checked."
              : `${personaName} is working toward: ${goalTitle}`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {plannedAttempts === 0 ? (
            <p className="text-sm text-muted-foreground">
              The number of attempts is known once the run starts.
            </p>
          ) : (
            <PassKStrip k={plannedAttempts} verdicts={verdicts} />
          )}
        </CardContent>
      </Card>
      {attempts.length === 0 ? (
        isTerminal ? (
          <Alert data-slot="sim-no-attempts">
            <AlertTitle>The run ended before the first message</AlertTitle>
            <AlertDescription>
              {loaded
                ? `No conversation was recorded. The run is ${run?.status ?? "finished"}.`
                : "Loading the recorded conversation."}
            </AlertDescription>
          </Alert>
        ) : (
          <EmptyState
            icon={MessagesSquare}
            title="Waiting for the first message"
            description="The simulated user opens the conversation as soon as the run starts. Messages appear here as they are sent."
          />
        )
      ) : (
        <div className="flex flex-col gap-3">
          {attempts.map((attempt, index) => (
            <AttemptCard
              key={attempt.sessionId}
              attempt={attempt}
              runEnded={isTerminal}
              open={index === attempts.length - 1}
              personaName={personaName}
              onOpenSession={setOpenSessionId}
            />
          ))}
        </div>
      )}
      <SessionSheet
        sessionId={openSessionId}
        targetId={targetId}
        onClose={() => setOpenSessionId(null)}
      />
    </section>
  );
}
