"use client";

import {
  ArrowRight,
  BookOpen,
  CircleCheck,
  MousePointerClick,
  TextCursorInput,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { EmptyState } from "@/components/states/empty-state";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { runRoutes } from "@/lib/routes";
import { useThrottledValue } from "@/lib/use-throttled-value";
import type { ExploreActionKind } from "@/lib/api/types";
import type { ExploreActionRow } from "../model";

export const TIMELINE_ANNOUNCE_INTERVAL_MS = 2000;

const ACTION_PRESENTATION = {
  navigate: { label: "Navigate", icon: ArrowRight },
  click: { label: "Click", icon: MousePointerClick },
  type: { label: "Type", icon: TextCursorInput },
  read: { label: "Read", icon: BookOpen },
  finish: { label: "Finish", icon: CircleCheck },
} as const satisfies Record<ExploreActionKind, { label: string; icon: LucideIcon }>;

export function describeAction(row: ExploreActionRow): string {
  const { label } = ACTION_PRESENTATION[row.action];
  const subject = row.action === "navigate" ? row.url : row.target;
  return subject === null ? label : `${label} ${subject}`;
}

export type ActionTimelineProps = {
  runId: string;
  actions: readonly ExploreActionRow[];
  live: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
};

function ActionItem({ runId, row }: { runId: string; row: ExploreActionRow }) {
  const presentation = ACTION_PRESENTATION[row.action];
  const Icon = presentation.icon;
  return (
    <li
      data-slot="explore-action"
      data-action={row.action}
      data-index={row.index}
      className="flex flex-col gap-1 border-l-2 border-border pb-4 pl-4 last:pb-0"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          <span className="sr-only">Action </span>#{row.index + 1}
        </span>
        <span className="inline-flex items-center gap-1 font-medium">
          <Icon aria-hidden="true" className="size-3.5" />
          {presentation.label}
        </span>
        {row.action === "navigate" || row.target === null ? null : (
          <span className="font-mono text-xs break-all">{row.target}</span>
        )}
        {row.action === "navigate" && row.url !== null ? (
          <span className="font-mono text-xs break-all">{row.url}</span>
        ) : null}
        {row.text === null ? null : (
          <span className="font-mono text-xs break-all">&ldquo;{row.text}&rdquo;</span>
        )}
        {row.stepId === null ? null : (
          <Button asChild size="xs" variant="outline" className="ml-auto">
            <Link href={runRoutes.step(runId, row.stepId)} scroll={false}>
              Open step
              <span className="sr-only"> of action {row.index + 1}</span>
            </Link>
          </Button>
        )}
      </div>
      <p className="text-sm wrap-break-word text-muted-foreground" data-slot="action-rationale">
        {row.rationale}
      </p>
    </li>
  );
}

export function ActionTimeline({
  runId,
  actions,
  live,
  hasOlder,
  loadingOlder,
  onLoadOlder,
}: ActionTimelineProps) {
  const headingId = useId();
  const followId = useId();
  const [follow, setFollow] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);
  const latest = actions.at(-1);
  const announced = useThrottledValue(
    latest === undefined ? "" : `Action ${latest.index + 1}: ${describeAction(latest)}`,
    TIMELINE_ANNOUNCE_INTERVAL_MS,
  );

  useEffect(() => {
    if (follow && live) {
      endRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [follow, live, actions.length]);

  return (
    <section
      aria-labelledby={headingId}
      data-slot="action-timeline"
      className="flex min-w-0 flex-col gap-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-base font-semibold">
          Action timeline
        </h2>
        {live ? (
          <div className="flex items-center gap-2">
            <Switch id={followId} checked={follow} onCheckedChange={setFollow} />
            <Label htmlFor={followId} className="font-normal">
              Follow the latest action
            </Label>
          </div>
        ) : null}
      </div>
      {hasOlder ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          disabled={loadingOlder}
          onClick={onLoadOlder}
        >
          {loadingOlder ? "Loading earlier actions" : "Load earlier actions"}
        </Button>
      ) : null}
      {actions.length === 0 ? (
        <EmptyState
          title="No actions yet"
          description={
            live
              ? "The explorer has not acted yet. Each action appears here with the reason for it."
              : "This run recorded no explorer actions."
          }
          className="py-10"
        />
      ) : (
        <div
          role="region"
          aria-label="Explorer actions"
          className="max-h-128 overflow-y-auto pr-1"
          tabIndex={0}
        >
          <ol aria-label="Explorer actions in order">
            {actions.map((row) => (
              <ActionItem key={row.index} runId={runId} row={row} />
            ))}
          </ol>
          <div ref={endRef} aria-hidden="true" className="h-px" />
        </div>
      )}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announced}
      </div>
    </section>
  );
}
