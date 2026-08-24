"use client";

import type { ArtifactRefresh } from "@/features/steps/use-artifact-refresh";
import type { Step } from "@/lib/api/types";
import { ArtifactImage } from "./artifact-image";
import { ArtifactTrace } from "./artifact-trace";
import { ArtifactVideo } from "./artifact-video";
import { EmptyNote, StepSection } from "./step-section";

export interface StepMediaProps {
  step: Step;
  refresh: ArtifactRefresh;
}

function describeMissingScreenshots(adapter: Step["adapter"]): string {
  return adapter === "browser"
    ? "No screenshot was captured for this step."
    : "This step ran over the API, so it has no screenshots.";
}

export function StepMedia({ step, refresh }: StepMediaProps) {
  const screenshots = step.artifacts.filter((artifact) => artifact.kind === "screenshot");
  const recording = step.artifacts.find((artifact) => artifact.kind === "recording");
  const trace = step.artifacts.find((artifact) => artifact.kind === "trace");
  const isBrowser = step.adapter === "browser";

  return (
    <>
      <StepSection title="Screenshots">
        {screenshots.length === 0 ? (
          <EmptyNote>{describeMissingScreenshots(step.adapter)}</EmptyNote>
        ) : (
          <ul data-slot="screenshot-list" className="grid gap-3 sm:grid-cols-2">
            {screenshots.map((artifact, index) => (
              <li key={artifact.id} className="min-w-0">
                <ArtifactImage
                  artifact={artifact}
                  alt={`Screenshot ${index + 1} of ${screenshots.length} for the step: ${step.label}`}
                  caption={`Screenshot ${index + 1} of ${screenshots.length}`}
                  refreshing={refresh.refreshing}
                  expired={refresh.isExpired(artifact)}
                  onLoadError={refresh.reportLoadError}
                  onReload={refresh.reload}
                />
              </li>
            ))}
          </ul>
        )}
      </StepSection>
      {recording !== undefined || isBrowser ? (
        <StepSection title="Recording">
          {recording === undefined ? (
            <EmptyNote>No recording was captured for this step.</EmptyNote>
          ) : (
            <ArtifactVideo
              artifact={recording}
              label={`Recording of the browser session for the step: ${step.label}`}
              refreshing={refresh.refreshing}
              expired={refresh.isExpired(recording)}
              onLoadError={refresh.reportLoadError}
              onReload={refresh.reload}
            />
          )}
        </StepSection>
      ) : null}
      {trace !== undefined || isBrowser ? (
        <StepSection title="Trace">
          {trace === undefined ? (
            <EmptyNote>No trace was captured for this step.</EmptyNote>
          ) : (
            <ArtifactTrace
              artifact={trace}
              refreshing={refresh.refreshing}
              expired={refresh.expired}
              onReload={refresh.reload}
            />
          )}
        </StepSection>
      ) : null}
    </>
  );
}
