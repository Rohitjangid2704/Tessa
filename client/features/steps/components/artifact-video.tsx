"use client";

import { useState } from "react";
import { artifactSource } from "@/features/steps/artifact-source";
import type { ArtifactRef } from "@/lib/api/types";
import { formatBytes } from "@/lib/format-bytes";
import { MediaExpired } from "./media-expired";
import { MediaUnavailable } from "./media-unavailable";

export interface ArtifactVideoProps {
  artifact: ArtifactRef;
  label: string;
  refreshing: boolean;
  expired?: boolean;
  onLoadError: (artifactUrl: string) => void;
  onReload: () => void;
}

export function ArtifactVideo({
  artifact,
  label,
  refreshing,
  expired = false,
  onLoadError,
  onReload,
}: ArtifactVideoProps) {
  const source = artifactSource(artifact);
  const [failedSource, setFailedSource] = useState<string | null>(null);

  if (expired) {
    return <MediaExpired subject="recording" onRecheck={onReload} className="aspect-video" />;
  }

  if (source === null || failedSource === source) {
    return (
      <MediaUnavailable
        subject="recording"
        refreshing={refreshing}
        onReload={onReload}
        className="aspect-video"
      />
    );
  }

  return (
    <figure data-slot="artifact-video" className="flex min-w-0 flex-col gap-1.5">
      <video
        key={source}
        src={source}
        controls
        preload="metadata"
        aria-label={label}
        className="aspect-video w-full rounded-md border bg-black"
        onError={() => {
          setFailedSource(source);
          onLoadError(artifact.url);
        }}
      />
      <figcaption className="text-xs text-muted-foreground">
        {`${artifact.mime}, ${formatBytes(artifact.size_bytes)}`}
      </figcaption>
    </figure>
  );
}
