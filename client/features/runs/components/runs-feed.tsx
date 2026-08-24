"use client";

import { RefreshCw } from "lucide-react";
import { LiveIndicator } from "@/components/status/live-indicator";
import { Button } from "@/components/ui/button";
import type { KnownStreamEvent } from "@/features/streams/events";
import { describeFeedConnection } from "../feed-connection";
import type { RunListFilters } from "../queries";
import { useRunsFeed } from "../use-runs-feed";

export type RunsFeedProps = {
  filters: RunListFilters;
  onRestart: () => void;
  onEvent?: (event: KnownStreamEvent) => void;
};

export function RunsFeed({ filters, onRestart, onEvent }: RunsFeedProps) {
  const feed = useRunsFeed(filters, onEvent);
  const view = describeFeedConnection(feed.status);
  const showMessage = feed.status === "reconnecting" || feed.status === "failed";

  return (
    <div
      data-slot="runs-feed"
      data-status={feed.status}
      className="flex flex-wrap items-center gap-2"
    >
      <LiveIndicator state={view.liveState} label={view.label} />
      {showMessage && feed.message !== null ? (
        <span className="text-xs text-muted-foreground">{feed.message}</span>
      ) : null}
      {feed.status === "failed" ? (
        <Button type="button" variant="outline" size="sm" onClick={onRestart}>
          <RefreshCw aria-hidden="true" data-icon="inline-start" />
          Retry live updates
        </Button>
      ) : null}
    </div>
  );
}
