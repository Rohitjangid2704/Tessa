"use client";

import { useQuery } from "@tanstack/react-query";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import { useHydrated } from "@/lib/use-hydrated";
import { agentSessionsQuery } from "../queries";
import { useAgentSessionsFeed } from "../use-agent-sessions-feed";
import { AgentSessionRow } from "./agent-session-row";

export function AgentSessionsPanel({ targetId }: { targetId: string }) {
  const hydrated = useHydrated();
  const query = useQuery(agentSessionsQuery(targetId));
  useAgentSessionsFeed(targetId);

  const sessions = query.data?.items;
  const total = query.data?.total ?? null;
  const pending = !hydrated || query.isPending;

  return (
    <Card data-slot="agent-sessions-panel">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Claude Code sessions
        </CardTitle>
        <CardDescription>Engineers who worked on this target through Claude Code.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {pending ? (
          <div role="status" aria-busy="true" className="flex flex-col gap-2">
            <span className="sr-only">Loading Claude Code sessions</span>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-56" />
          </div>
        ) : query.isError ? (
          <ErrorState
            title="Could not load the sessions"
            description={describeApiError(query.error)}
            requestId={readRequestId(query.error)}
            onRetry={() => void query.refetch()}
            className="py-6"
          />
        ) : sessions === undefined || sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-slot="agent-sessions-empty">
            No Claude Code session has worked on this target yet. Sessions appear here when an
            engineer connects the Tessa plugin and picks this target.
          </p>
        ) : (
          <>
            <ul aria-label="Claude Code sessions" className="m-0 flex list-none flex-col p-0">
              {sessions.map((session) => (
                <AgentSessionRow key={session.id} session={session} />
              ))}
            </ul>
            {total !== null && total > sessions.length ? (
              <p className="text-xs text-muted-foreground tabular-nums">
                Showing the newest {sessions.length} of {total} sessions.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
