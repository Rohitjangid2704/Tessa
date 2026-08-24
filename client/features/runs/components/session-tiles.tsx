"use client";

import { useQuery } from "@tanstack/react-query";
import { runBrowserSessionsQuery } from "../run-detail-queries";
import { useSessionEvents } from "../use-session-events";
import { TileGrid } from "./tile-grid";

export type SessionTilesProps = { runId: string };

export function SessionTiles({ runId }: SessionTilesProps) {
  const sessionsQuery = useQuery(runBrowserSessionsQuery(runId));
  const sessionEvents = useSessionEvents();
  const restCount = sessionsQuery.data?.items.length ?? 0;
  const hasSessions = restCount > 0 || sessionEvents.started.length > 0;

  if (sessionsQuery.isPending && !hasSessions) {
    return null;
  }
  if (!hasSessions && !sessionsQuery.isError) {
    return null;
  }
  return <TileGrid runId={runId} />;
}
