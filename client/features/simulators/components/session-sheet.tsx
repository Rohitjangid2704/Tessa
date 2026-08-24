"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { CopyButton } from "@/components/copy-button";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { TierBadge } from "@/components/status/tier-badge";
import { VerdictBadge } from "@/components/status/verdict-badge";
import { Transcript, type TranscriptEntry } from "@/components/transcript";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError, isApiError } from "@/lib/api/errors";
import { runRoutes } from "@/lib/routes";
import { simSessionQuery } from "../queries";
import { useSimulatorNames } from "../use-simulator-names";
import type { SimSession, SimSpeaker } from "../types";
import { ChecksStrip } from "./checks-strip";

export const PERSONA_SPEAKER_LABEL = "Simulated user";
export const TARGET_SPEAKER_LABEL = "The app";

export function speakerLabel(speaker: SimSpeaker, personaName: string | null): string {
  if (speaker === "target") {
    return TARGET_SPEAKER_LABEL;
  }
  return personaName === null ? PERSONA_SPEAKER_LABEL : `${PERSONA_SPEAKER_LABEL}, ${personaName}`;
}

export function speakerSide(speaker: SimSpeaker): TranscriptEntry["side"] {
  return speaker === "persona" ? "end" : "start";
}

function Facts({
  session,
  personaName,
  goalTitle,
}: {
  session: SimSession;
  personaName: string | null;
  goalTitle: string | null;
}) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <dt className="text-muted-foreground">Persona</dt>
      <dd>{personaName ?? "A persona that no longer exists"}</dd>
      <dt className="text-muted-foreground">Goal</dt>
      <dd>{goalTitle ?? "A goal that no longer exists"}</dd>
      <dt className="text-muted-foreground">Attempt</dt>
      <dd className="tabular-nums">{session.attempt + 1}</dd>
      <dt className="text-muted-foreground">Run</dt>
      <dd>
        <Link
          href={runRoutes.detail(session.run_id)}
          className="font-mono text-xs underline underline-offset-4"
        >
          {session.run_id}
        </Link>
      </dd>
    </dl>
  );
}

function SessionBody({ session, targetId }: { session: SimSession; targetId: string | null }) {
  const names = useSimulatorNames(targetId);
  const personaName = names.personaName(session.persona_id);
  const entries: TranscriptEntry[] = session.transcript.map((turn) => ({
    key: `${session.id}-${turn.turn}`,
    speaker: speakerLabel(turn.speaker, personaName),
    side: speakerSide(turn.speaker),
    text: turn.text,
    note: `Turn ${turn.turn}`,
  }));
  return (
    <div data-slot="session-body" className="flex flex-col gap-5 px-4 pb-6">
      <Facts session={session} personaName={personaName} goalTitle={names.goalTitle(session.goal_id)} />
      <section aria-label="Verdict" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <VerdictBadge verdict={session.verdict.status} />
          <TierBadge tier={session.verdict.tier} />
        </div>
        {session.verdict.reason === null ? null : (
          <p className="text-sm text-muted-foreground">{session.verdict.reason}</p>
        )}
        <ChecksStrip checks={session.checks} />
      </section>
      <section aria-label="Conversation" className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Full conversation</h3>
        <p className="text-xs text-muted-foreground">
          This text comes from the simulated user and the app. It is shown as plain text and may
          hold personal data.
        </p>
        <Transcript
          label={`Full conversation of attempt ${session.attempt + 1}`}
          entries={entries}
          followByDefault={false}
          listClassName="max-h-[28rem]"
        />
      </section>
      <div className="flex flex-wrap items-center gap-2">
        <CopyButton text={session.id} subject="session id" variant="outline" size="sm" />
        <span className="font-mono text-xs text-muted-foreground">{session.id}</span>
      </div>
    </div>
  );
}

function SessionDetails({ sessionId, targetId }: { sessionId: string; targetId: string | null }) {
  const query = useQuery(simSessionQuery(sessionId));

  if (query.isPending) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-3 px-4">
        <span className="sr-only">Loading the session</span>
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (query.isError) {
    const notFound = isApiError(query.error) && query.error.status === 404;
    return (
      <div className="px-4">
        <ErrorState
          title={notFound ? "Session not found" : "Could not load the session"}
          description={
            notFound
              ? "A session appears once its attempt has been checked, or it was removed."
              : describeApiError(query.error)
          }
          requestId={readRequestId(query.error)}
          onRetry={notFound ? undefined : () => void query.refetch()}
          className="py-8"
        />
      </div>
    );
  }

  return <SessionBody session={query.data} targetId={targetId} />;
}

export interface SessionSheetProps {
  sessionId: string | null;
  targetId: string | null;
  onClose: () => void;
}

export function SessionSheet({ sessionId, targetId, onClose }: SessionSheetProps) {
  return (
    <Sheet
      open={sessionId !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <SheetContent data-slot="session-sheet" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Simulation session</SheetTitle>
          <SheetDescription>
            The whole conversation of one attempt and the five checks that decided its verdict.
          </SheetDescription>
        </SheetHeader>
        {sessionId === null ? null : (
          <SessionDetails key={sessionId} sessionId={sessionId} targetId={targetId} />
        )}
      </SheetContent>
    </Sheet>
  );
}
