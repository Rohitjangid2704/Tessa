"use client";

import { useQuery } from "@tanstack/react-query";
import { ArtifactVideo } from "@/features/steps/components/artifact-video";
import { stepQuery } from "@/features/steps/queries";
import { useArtifactRefresh } from "@/features/steps/use-artifact-refresh";
import { describeApiError, isApiError } from "@/lib/api/errors";
import type { ArtifactRef } from "@/lib/api/types";
import { ErrorState } from "@/components/states/error-state";
import { Skeleton } from "@/components/ui/skeleton";

const NO_ARTIFACTS: readonly ArtifactRef[] = [];

export type RecordingPlayerProps = { stepId: string };

export function RecordingPlayer({ stepId }: RecordingPlayerProps) {
  const step = useQuery(stepQuery(stepId));
  const refresh = useArtifactRefresh(step.data?.artifacts ?? NO_ARTIFACTS, step.refetch);
  const recording = step.data?.artifacts.find((artifact) => artifact.kind === "recording");

  if (step.isPending) {
    return (
      <div role="status" aria-busy="true">
        <span className="sr-only">Loading the recording</span>
        <Skeleton className="aspect-video w-full" />
      </div>
    );
  }
  if (step.isError) {
    return (
      <ErrorState
        title="Could not load the recording"
        description={describeApiError(step.error)}
        requestId={isApiError(step.error) ? step.error.requestId : null}
        onRetry={() => void step.refetch()}
        className="py-8"
      />
    );
  }
  if (recording === undefined) {
    return (
      <p className="text-sm text-muted-foreground" data-slot="recording-missing">
        No recording was captured for this exploration.
      </p>
    );
  }
  return (
    <ArtifactVideo
      artifact={recording}
      label="Recording of the explorer browser session"
      refreshing={refresh.refreshing}
      expired={refresh.isExpired(recording)}
      onLoadError={refresh.reportLoadError}
      onReload={refresh.reload}
    />
  );
}
