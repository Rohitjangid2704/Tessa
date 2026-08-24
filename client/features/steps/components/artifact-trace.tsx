"use client";

import { Download } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { artifactSource } from "@/features/steps/artifact-source";
import type { ArtifactRef } from "@/lib/api/types";
import { formatBytes } from "@/lib/format-bytes";
import { MediaExpired } from "./media-expired";
import { MediaUnavailable } from "./media-unavailable";

export const TRACE_COMMAND = "npx playwright show-trace trace.zip";

export interface ArtifactTraceProps {
  artifact: ArtifactRef;
  refreshing: boolean;
  expired?: boolean;
  onReload: () => void;
}

export function ArtifactTrace({
  artifact,
  refreshing,
  expired = false,
  onReload,
}: ArtifactTraceProps) {
  const source = artifactSource(artifact);

  if (expired) {
    return <MediaExpired subject="trace" onRecheck={onReload} />;
  }

  if (source === null) {
    return <MediaUnavailable subject="trace" refreshing={refreshing} onReload={onReload} />;
  }

  return (
    <div data-slot="artifact-trace" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="outline" size="sm">
          <a href={source} download>
            <Download aria-hidden="true" data-icon="inline-start" />
            Download trace
          </a>
        </Button>
        <span className="text-xs text-muted-foreground">
          {`Playwright trace, ${formatBytes(artifact.size_bytes)}`}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-sm text-muted-foreground">
          Open the downloaded file in the Playwright trace viewer. Replace trace.zip with the path
          where you saved it.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs">
            {TRACE_COMMAND}
          </code>
          <CopyButton text={TRACE_COMMAND} subject="trace command" variant="ghost" size="xs" />
        </div>
      </div>
    </div>
  );
}
