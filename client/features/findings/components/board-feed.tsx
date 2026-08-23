"use client";

import { RefreshCw } from "lucide-react";
import { describeFeedConnection } from "@/features/runs/feed-connection";
import { LiveIndicator } from "@/components/status/live-indicator";
import { Button } from "@/components/ui/button";
import type { FindingBoardFilters } from "../schemas";
import { useFindingsFeed } from "../use-findings-feed";
import { NewFindingsPill } from "./new-findings-pill";

export interface BoardFeedProps {
  targetId: string;
  filters: FindingBoardFilters;
  onRestart: () => void;
}

export function BoardFeed({ targetId, filters, onRestart }: BoardFeedProps) {
  const feed = useFindingsFeed({ targetId, filters });
  const view = describeFeedConnection(feed.state.status);
  const showMessage = feed.state.status === "reconnecting" || feed.state.status === "failed";

  return (
    <div
      data-slot="findings-feed"
      data-status={feed.state.status}
      className="flex flex-wrap items-center gap-2"
    >
      <LiveIndicator state={view.liveState} label={view.label} />
      {showMessage && feed.state.message !== null ? (
        <span className="text-xs text-muted-foreground">{feed.state.message}</span>
      ) : null}
      {feed.state.status === "failed" ? (
        <Button type="button" variant="outline" size="sm" onClick={onRestart}>
          <RefreshCw aria-hidden="true" data-icon="inline-start" />
          Retry live updates
        </Button>
      ) : null}
      <NewFindingsPill count={feed.buffered.length} onShow={feed.showBuffered} />
    </div>
  );
}
