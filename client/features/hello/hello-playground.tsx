"use client";

import { useState } from "react";
import { routes, withQuery } from "@/lib/routes";
import { DEFAULT_HELLO_INPUT, HelloControls } from "./hello-controls";
import { HelloRun } from "./hello-run";
import { deriveHelloPhase, phaseLiveState } from "./hello-phase";
import { HelloStatus } from "./hello-status";
import { useStartHelloRun, type HelloRunInput } from "./mutations";

function writeRunIdToUrl(runId: string | null): void {
  const target = runId === null ? routes.devHello : withQuery(routes.devHello, { run_id: runId });
  window.history.replaceState(null, "", target);
}

export function HelloPlayground({ initialRunId = null }: { initialRunId?: string | null }) {
  const [input, setInput] = useState<HelloRunInput>(DEFAULT_HELLO_INPUT);
  const [runId, setRunId] = useState<string | null>(initialRunId);
  const mutation = useStartHelloRun();

  function start(requested: HelloRunInput) {
    setRunId(null);
    writeRunIdToUrl(null);
    mutation.mutate(requested, {
      onSuccess: (handle) => {
        setRunId(handle.run_id);
        writeRunIdToUrl(handle.run_id);
      },
    });
  }

  const startingOrFailed = runId === null;
  const phase = deriveHelloPhase({
    runId,
    startPending: mutation.isPending,
    startError: mutation.error,
    historyPending: false,
    historyError: null,
    socketStatus: null,
    socketMessage: null,
    socketAttempt: 0,
    finishedStatus: null,
  });

  return (
    <div className="flex flex-col gap-6">
      <HelloControls
        value={input}
        onChange={setInput}
        onSubmit={start}
        pending={mutation.isPending}
      />
      {startingOrFailed ? (
        <HelloStatus
          phase={phase}
          liveState={phaseLiveState(phase, null)}
          runId={null}
          lastSeq={null}
        />
      ) : (
        <HelloRun key={runId} runId={runId} />
      )}
    </div>
  );
}
