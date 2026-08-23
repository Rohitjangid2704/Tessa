import { CircleAlert, ServerOff } from "lucide-react";
import { LiveIndicator } from "@/components/status/live-indicator";
import type { LiveState } from "@/components/status/status-types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { phaseTitle, type HelloPhase } from "./hello-phase";

function phaseDetail(phase: HelloPhase): string | null {
  switch (phase.kind) {
    case "idle":
      return "Start a run to watch its events arrive over the WebSocket.";
    case "starting":
      return "Asking the API to start the workflow.";
    case "connecting":
      return phase.detail;
    case "reconnecting":
      return `Attempt ${phase.attempt}. ${phase.detail}.`;
    case "resyncing":
      return "The server could not replay the gap, so the event log is being reloaded.";
    case "streaming":
      return "Events appear below as they arrive.";
    case "finished":
      return "The run is finished and the stream is closed.";
    default:
      return null;
  }
}

export function HelloStatus({
  phase,
  liveState,
  runId,
  lastSeq,
}: {
  phase: HelloPhase;
  liveState: LiveState;
  runId: string | null;
  lastSeq: number | null;
}) {
  const detail = phaseDetail(phase);
  return (
    <section
      aria-label="Run status"
      data-testid="hello-status"
      data-phase={phase.kind}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-center gap-3">
        <LiveIndicator state={liveState} />
        <p className="text-sm font-medium" data-testid="hello-phase">
          {phaseTitle(phase)}
        </p>
        {runId !== null ? (
          <p className="font-mono text-xs text-muted-foreground" data-testid="hello-run-id">
            {runId}
          </p>
        ) : null}
        {lastSeq !== null ? (
          <p className="text-xs text-muted-foreground" data-testid="hello-last-seq">
            last seq {lastSeq}
          </p>
        ) : null}
      </div>
      {detail !== null ? <p className="text-sm text-muted-foreground">{detail}</p> : null}
      {phase.kind === "unavailable" ? (
        <Alert variant="destructive" data-testid="hello-unavailable">
          <ServerOff aria-hidden="true" />
          <AlertTitle>{phase.message}</AlertTitle>
          <AlertDescription>
            The API could not reach {phase.dependency ?? "a dependency"}. Start it and try again.
          </AlertDescription>
        </Alert>
      ) : null}
      {phase.kind === "failed" ? (
        <Alert variant="destructive" data-testid="hello-failed">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>The run could not continue</AlertTitle>
          <AlertDescription>{phase.message}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}
