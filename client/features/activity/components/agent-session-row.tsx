"use client";

import { Bot, CircleDot, Clock, SquareCheck } from "lucide-react";
import { useId, useState } from "react";
import { DateTime } from "@/components/date-time";
import { StatusBadge } from "@/components/status/status-badge";
import { Button } from "@/components/ui/button";
import type { AgentSession } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import {
  agentSessionState,
  pluralizeWrites,
  summaryNeedsExpander,
  type AgentSessionState,
} from "../sessions";

const STATE_BADGES = {
  active: { label: "Active", tone: "kpi-good", icon: CircleDot },
  ended: { label: "Ended", tone: "hollow", icon: SquareCheck },
  inactive: { label: "Inactive", tone: "kpi-warn", icon: Clock },
} as const;

const STATE_HINTS: Record<AgentSessionState, string | undefined> = {
  active: undefined,
  ended: undefined,
  inactive: "No end was recorded and the session started more than 12 hours ago",
};

export function AgentSessionStateChip({ state }: { state: AgentSessionState }) {
  const badge = STATE_BADGES[state];
  return (
    <StatusBadge
      data-state={state}
      tone={badge.tone}
      label={badge.label}
      icon={badge.icon}
      title={STATE_HINTS[state]}
    />
  );
}

export function AgentSessionRow({ session }: { session: AgentSession }) {
  const [expanded, setExpanded] = useState(false);
  const summaryId = useId();
  const state = agentSessionState(session);
  const expandable = summaryNeedsExpander(session.summary);

  return (
    <li
      data-slot="agent-session-row"
      data-state={state}
      data-session-id={session.id}
      className="flex flex-col gap-1.5 border-b py-3 first:pt-0 last:border-b-0 last:pb-0"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Bot aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium">{session.user_name}</span>
        <AgentSessionStateChip state={state} />
      </div>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          Started <DateTime value={session.started_at} />
        </span>
        {session.ended_at === null ? null : (
          <span>
            Ended <DateTime value={session.ended_at} />
          </span>
        )}
        <code className="font-mono">{session.cwd_label}</code>
        <span className="tabular-nums">{pluralizeWrites(session.write_count)}</span>
      </p>
      {session.summary === null || session.summary === "" ? null : (
        <div className="flex flex-col items-start gap-1">
          <p
            id={summaryId}
            data-slot="agent-session-summary"
            className={cn("text-sm wrap-anywhere", !expanded && "line-clamp-2")}
          >
            {session.summary}
          </p>
          {expandable ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-expanded={expanded}
              aria-controls={summaryId}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? "Show less" : "Show more"}
            </Button>
          ) : null}
        </div>
      )}
    </li>
  );
}
