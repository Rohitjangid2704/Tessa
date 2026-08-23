"use client";

import { Ticket } from "lucide-react";
import type { MouseEvent } from "react";
import { SeverityBadge } from "@/components/status/severity-badge";
import { Badge } from "@/components/ui/badge";
import type { FindingStatus, FindingSummary } from "@/lib/api/types";
import { safeHttpUrl } from "@/lib/safe-http-url";
import { cn } from "@/lib/utils";
import { formatOccurrenceCount } from "../format";
import { pluralize } from "../labels";
import { FindingClassChip } from "./finding-class-chip";
import { LastSeen } from "./last-seen";
import { MoveMenu } from "./move-menu";

export interface FindingCardProps {
  finding: FindingSummary;
  href: string;
  moving: boolean;
  onOpen: (findingId: string) => void;
  onMove: (finding: FindingSummary, to: FindingStatus) => void;
}

function isPlainPrimaryClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

export function FindingCard({ finding, href, moving, onOpen, onMove }: FindingCardProps) {
  const ticketUrl = safeHttpUrl(finding.ticket_url);
  const occurrenceWord = pluralize(finding.occurrence_count, "occurrence");

  function handleOpen(event: MouseEvent<HTMLAnchorElement>): void {
    if (isPlainPrimaryClick(event)) {
      event.preventDefault();
      onOpen(finding.id);
    }
  }

  return (
    <li
      data-slot="finding-card"
      data-status={finding.status}
      aria-busy={moving}
      className={cn(
        "flex flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground shadow-xs",
        moving && "opacity-70",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <a
          href={href}
          data-finding-open={finding.id}
          onClick={handleOpen}
          className="min-w-0 flex-1 rounded-sm text-sm leading-snug font-medium wrap-anywhere underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {finding.title}
        </a>
        <MoveMenu finding={finding} disabled={moving} onMove={onMove} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <SeverityBadge severity={finding.severity} />
        <FindingClassChip findingClass={finding.class} />
        {moving ? <Badge variant="secondary">Moving</Badge> : null}
      </div>
      {finding.status === "known_gap" && finding.known_gap_reason !== null ? (
        <p className="line-clamp-2 text-xs wrap-anywhere text-muted-foreground">
          <span className="font-medium text-foreground">Reason:</span> {finding.known_gap_reason}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          <span aria-hidden="true">{`×${formatOccurrenceCount(finding.occurrence_count)}`}</span>
          <span className="sr-only">
            {finding.occurrence_count} {occurrenceWord}
          </span>
        </span>
        <span>
          Last seen <LastSeen value={finding.last_seen_at} />
        </span>
        {ticketUrl === null ? null : (
          <a
            href={ticketUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open the ticket for ${finding.title} (opens in a new tab)`}
            className="inline-flex items-center gap-1 rounded-sm text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <Ticket aria-hidden="true" className="size-3.5" />
            Ticket
          </a>
        )}
      </div>
    </li>
  );
}
