"use client";

import { useQuery } from "@tanstack/react-query";
import { runEventsQuery } from "@/features/streams/run-events";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { HelloLiveRun } from "./hello-live-run";
import { deriveHelloPhase, phaseLiveState } from "./hello-phase";
import { HelloStatus } from "./hello-status";

export function HelloRun({ runId }: { runId: string }) {
  const history = useQuery({ ...runEventsQuery(runId), meta: INLINE_ERROR_META });

  if (history.data !== undefined) {
    return <HelloLiveRun runId={runId} history={history.data} />;
  }

  const phase = deriveHelloPhase({
    runId,
    startPending: false,
    startError: null,
    historyPending: history.isPending,
    historyError: history.error,
    socketStatus: null,
    socketMessage: null,
    socketAttempt: 0,
    finishedStatus: null,
  });
  return (
    <HelloStatus
      phase={phase}
      liveState={phaseLiveState(phase, null)}
      runId={runId}
      lastSeq={null}
    />
  );
}
