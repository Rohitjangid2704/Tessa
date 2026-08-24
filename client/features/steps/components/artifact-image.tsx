"use client";

import { ExternalLink } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { artifactSource } from "@/features/steps/artifact-source";
import type { ArtifactRef } from "@/lib/api/types";
import { formatBytes } from "@/lib/format-bytes";
import { MediaExpired } from "./media-expired";
import { MediaUnavailable } from "./media-unavailable";

export interface ArtifactImageProps {
  artifact: ArtifactRef;
  alt: string;
  caption: string;
  refreshing: boolean;
  expired?: boolean;
  onLoadError: (artifactUrl: string) => void;
  onReload: () => void;
}

export function ArtifactImage({
  artifact,
  alt,
  caption,
  refreshing,
  expired = false,
  onLoadError,
  onReload,
}: ArtifactImageProps) {
  const source = artifactSource(artifact);
  const [failedSource, setFailedSource] = useState<string | null>(null);

  if (expired) {
    return <MediaExpired subject="screenshot" onRecheck={onReload} className="aspect-16/10" />;
  }

  if (source === null || failedSource === source) {
    return (
      <MediaUnavailable
        subject="screenshot"
        refreshing={refreshing}
        onReload={onReload}
        className="aspect-16/10"
      />
    );
  }

  return (
    <figure data-slot="artifact-image" className="flex min-w-0 flex-col gap-1.5">
      <div className="relative aspect-16/10 w-full overflow-hidden rounded-md border bg-muted">
        <Image
          src={source}
          alt={alt}
          fill
          unoptimized
          sizes="(min-width: 640px) 50vw, 100vw"
          className="object-contain"
          onError={() => {
            setFailedSource(source);
            onLoadError(artifact.url);
          }}
        />
      </div>
      <figcaption className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{`${caption}, ${formatBytes(artifact.size_bytes)}`}</span>
        <a
          href={source}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-foreground underline underline-offset-4"
        >
          Open full size
          <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      </figcaption>
    </figure>
  );
}
