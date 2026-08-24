"use client";

import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { LiveIndicator } from "@/components/status/live-indicator";
import { DateTime } from "@/components/date-time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BundleSourceChips } from "@/features/bundles/components/bundle-source-chips";
import { pluralize } from "@/features/bundles/format";
import { bundleDetailQuery } from "@/features/bundles/queries";
import { ClaudeCodeCommand } from "@/features/claude-code/components/claude-code-command";
import { describeFeedConnection } from "@/features/runs/feed-connection";
import type { EventStreamState } from "@/lib/sse/stream";
import { countByStatus } from "../selection";
import type { Proposal } from "../types";

export interface ProposalHeaderProps {
  proposal: Proposal;
  items: Proposal["items"];
  stream: EventStreamState;
  onRestartFeed: () => void;
}

function BundleVersion({ bundleId }: { bundleId: string }) {
  const bundle = useQuery(bundleDetailQuery(bundleId));
  return (
    <span data-slot="proposal-bundle">
      Bundle version{" "}
      <span className="font-medium tabular-nums">
        {bundle.data === undefined ? "loading" : bundle.data.version}
      </span>
    </span>
  );
}

export function ProposalHeader({ proposal, items, stream, onRestartFeed }: ProposalHeaderProps) {
  const counts = countByStatus(items);
  const connection = describeFeedConnection(stream.status);
  const showMessage = stream.status === "reconnecting" || stream.status === "failed";

  return (
    <header data-slot="proposal-header" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">Test proposal</h2>
          <p className="text-sm text-muted-foreground">
            {pluralize(items.length, "item")}: {counts.selected} selected, {counts.declined}{" "}
            declined, {counts.authored} authored, {counts.covered} covered
          </p>
        </div>
        <div
          data-slot="proposal-feed"
          data-status={stream.status}
          className="flex flex-wrap items-center gap-2"
        >
          <LiveIndicator state={connection.liveState} label={connection.label} />
          {showMessage && stream.message !== null ? (
            <span className="text-xs text-muted-foreground">{stream.message}</span>
          ) : null}
          {stream.status === "failed" ? (
            <Button type="button" variant="outline" size="sm" onClick={onRestartFeed}>
              <RefreshCw aria-hidden="true" data-icon="inline-start" />
              Retry live updates
            </Button>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <span>
          Generated <DateTime value={proposal.generated_at} />
        </span>
        <BundleSourceChips bundle={proposal} />
        {proposal.bundle_id === null ? null : <BundleVersion bundleId={proposal.bundle_id} />}
        <Badge variant="outline" data-slot="proposal-origin">
          {proposal.source === "bundle" ? "From a bundle upload" : "Stored through the API"}
        </Badge>
      </div>
      {proposal.stale ? (
        <Alert data-slot="proposal-stale" role="status">
          <RefreshCw aria-hidden="true" />
          <AlertTitle>
            <Badge variant="outline">Stale</Badge> A newer bundle exists
          </AlertTitle>
          <AlertDescription>
            <p>
              This proposal was written for an older bundle, so some items may point at features
              that changed. Propose again to refresh it; your ticks stay on items that keep their
              key.
            </p>
            <ClaudeCodeCommand template="propose" />
          </AlertDescription>
        </Alert>
      ) : null}
    </header>
  );
}
