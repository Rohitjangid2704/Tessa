"use client";

import { useState } from "react";
import type { KnownStreamEvent } from "@/features/streams/events";
import type { LoadedRunEvents } from "@/features/streams/run-events";
import { createListStore, useStore } from "@/lib/store";
import { useRunSocket } from "@/lib/ws/use-run-socket";
import { HelloEventList, shouldListEvent } from "./hello-event-list";
import { deriveHelloPhase, findFinishedStatus, phaseLiveState } from "./hello-phase";
import { HelloStatus } from "./hello-status";

export function HelloLiveRun({ runId, history }: { runId: string; history: LoadedRunEvents }) {
  const [list] = useState(() =>
    createListStore<KnownStreamEvent>({ initial: history.events.filter(shouldListEvent) }),
  );
  const events = useStore(list);
  const finishedStatus = findFinishedStatus(events);

  const socket = useRunSocket(runId, {
    initialLastSeq: history.lastSeq,
    enabled: finishedStatus === null,
    onEvent: (event) => {
      if (shouldListEvent(event)) {
        list.append(event);
      }
    },
  });

  const phase = deriveHelloPhase({
    runId,
    startPending: false,
    startError: null,
    historyPending: false,
    historyError: null,
    socketStatus: socket.status,
    socketMessage: socket.message,
    socketAttempt: socket.attempt,
    finishedStatus,
  });

  return (
    <div className="flex flex-col gap-4">
      <HelloStatus
        phase={phase}
        liveState={phaseLiveState(phase, socket.status)}
        runId={runId}
        lastSeq={socket.lastSeq}
      />
      <HelloEventList events={events} />
    </div>
  );
}
