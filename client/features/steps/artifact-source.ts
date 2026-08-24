import { resolveArtifactUrl } from "@/lib/api/artifact-url";
import type { ArtifactRef } from "@/lib/api/types";

export function artifactSource(artifact: Pick<ArtifactRef, "url">): string | null {
  try {
    return resolveArtifactUrl(artifact.url);
  } catch {
    return null;
  }
}
