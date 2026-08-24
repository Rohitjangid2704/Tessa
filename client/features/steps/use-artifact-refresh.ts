import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { ArtifactRef } from "@/lib/api/types";

export const ARTIFACT_REFRESH_LEAD_MS = 60_000;
export const ARTIFACT_REFRESH_FLOOR_MS = 15_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface ArtifactRefresh {
  refreshing: boolean;
  expired: boolean;
  isExpired: (artifact: Pick<ArtifactRef, "url">) => boolean;
  reportLoadError: (artifactUrl?: string) => void;
  reload: () => void;
}

export type StepRefetch = (options?: { cancelRefetch?: boolean }) => Promise<unknown>;

export function earliestExpiry(artifacts: readonly ArtifactRef[]): number | null {
  let earliest: number | null = null;
  for (const artifact of artifacts) {
    const expiresAt = Date.parse(artifact.expires_at);
    if (!Number.isNaN(expiresAt) && (earliest === null || expiresAt < earliest)) {
      earliest = expiresAt;
    }
  }
  return earliest;
}

export function refreshDelay(expiresAt: number, now: number): number {
  const untilLead = expiresAt - now - ARTIFACT_REFRESH_LEAD_MS;
  return Math.min(Math.max(untilLead, ARTIFACT_REFRESH_FLOOR_MS), MAX_TIMER_DELAY_MS);
}

export function useArtifactRefresh(
  artifacts: readonly ArtifactRef[],
  refetch: StepRefetch,
): ArtifactRefresh {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshed, setRefreshed] = useState(false);
  const [failedUrls, setFailedUrls] = useState<readonly string[]>([]);
  const autoRefreshed = useRef(false);
  const expiry = earliestExpiry(artifacts);

  function isExpired(artifact: Pick<ArtifactRef, "url">): boolean {
    return refreshed && !refreshing && failedUrls.includes(artifact.url);
  }

  const expired = artifacts.some((artifact) => isExpired(artifact));

  function refresh(): void {
    setRefreshing(true);
    void refetch({ cancelRefetch: false }).finally(() => {
      setRefreshed(true);
      setRefreshing(false);
    });
  }

  const refreshOnTimer = useEffectEvent(refresh);

  useEffect(() => {
    if (expiry === null || expired) {
      return;
    }
    const timer = setTimeout(() => refreshOnTimer(), refreshDelay(expiry, Date.now()));
    return () => clearTimeout(timer);
  }, [expiry, expired]);

  function reportLoadError(artifactUrl?: string): void {
    if (artifactUrl !== undefined) {
      setFailedUrls((current) =>
        current.includes(artifactUrl) ? current : [...current, artifactUrl],
      );
    }
    if (autoRefreshed.current) {
      return;
    }
    autoRefreshed.current = true;
    refresh();
  }

  return { refreshing, expired, isExpired, reportLoadError, reload: refresh };
}
