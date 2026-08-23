"use client";

import { OctagonAlert, RefreshCw, WifiOff, X } from "lucide-react";
import Link from "next/link";
import { LiveIndicator } from "@/components/status/live-indicator";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { describeFeedConnection } from "@/features/runs/feed-connection";
import { shortRunId } from "@/features/runs/run-status";
import { TargetName } from "@/features/targets/components/target-name";
import { formatUsd } from "@/lib/format-usd";
import { runRoutes } from "@/lib/routes";
import type { EventStreamState } from "@/lib/sse/stream";
import type { BudgetNotice } from "../use-home-feed";

export type HomeStatusBarProps = {
  targetId: string | null;
  state: EventStreamState;
};

export function HomeStatusBar({ targetId, state }: HomeStatusBarProps) {
  const view = describeFeedConnection(state.status);
  return (
    <div data-slot="home-status" className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-muted-foreground">
        {targetId === null ? (
          "Showing all targets"
        ) : (
          <>
            Showing <TargetName targetId={targetId} />
          </>
        )}
      </p>
      <LiveIndicator state={view.liveState} label={view.label} data-feed-status={state.status} />
    </div>
  );
}

export type StaleBannerProps = {
  state: EventStreamState;
  onRetry: () => void;
};

export function isFeedStale(state: EventStreamState): boolean {
  return state.status === "reconnecting" || state.status === "failed";
}

export function StaleBanner({ state, onRetry }: StaleBannerProps) {
  const failed = state.status === "failed";
  return (
    <div
      role="status"
      data-slot="stale-banner"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-kpi-warn-fg/25 bg-kpi-warn-bg px-3 py-2 text-sm text-kpi-warn-fg"
    >
      <WifiOff aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        {failed
          ? "Live updates stopped. The numbers below may be out of date."
          : "Live updates are paused while the connection recovers. The numbers below may be out of date."}
        {state.message === null ? "" : ` ${state.message}.`}
      </span>
      {failed ? (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw aria-hidden="true" data-icon="inline-start" />
          Retry live updates
        </Button>
      ) : null}
    </div>
  );
}

const DIMENSION_LABELS = {
  usd: "spending limit",
  minutes: "time limit",
} as const satisfies Record<BudgetNotice["dimension"], string>;

function formatMeasure(dimension: BudgetNotice["dimension"], value: number): string {
  return dimension === "usd" ? formatUsd(value) : `${value} min`;
}

export type BudgetBannerProps = {
  notice: BudgetNotice;
  onDismiss: () => void;
};

export function BudgetBanner({ notice, onDismiss }: BudgetBannerProps) {
  return (
    <Alert variant="destructive" data-slot="budget-banner" className="pr-24">
      <OctagonAlert aria-hidden="true" />
      <AlertTitle>A run reached its budget</AlertTitle>
      <AlertDescription>
        <p>
          {notice.runId === null ? "A run" : `Run ${shortRunId(notice.runId)}`} hit its{" "}
          {DIMENSION_LABELS[notice.dimension]}: {formatMeasure(notice.dimension, notice.actual)}{" "}
          against a limit of {formatMeasure(notice.dimension, notice.limit)}.
          {notice.runId === null ? null : (
            <>
              {" "}
              <Link href={runRoutes.detail(notice.runId)}>Open the run</Link>
            </>
          )}
        </p>
      </AlertDescription>
      <AlertAction>
        <Button type="button" variant="ghost" size="xs" onClick={onDismiss}>
          <X aria-hidden="true" data-icon="inline-start" />
          Dismiss
        </Button>
      </AlertAction>
    </Alert>
  );
}
