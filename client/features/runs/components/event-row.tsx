"use client";

import {
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleX,
  Info,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useId } from "react";
import { CopyButton } from "@/components/copy-button";
import { formatUtc } from "@/components/date-time";
import { Badge } from "@/components/ui/badge";
import { describeEvent, type EventTone } from "@/features/streams/describe-event";
import { cn } from "@/lib/utils";
import { formatEventClock, formatEventJson, previewJson, type LogRow } from "../event-log-model";

interface TonePresentation {
  icon: LucideIcon;
  className: string;
  label: string;
}

const TONE_PRESENTATION = {
  neutral: { icon: Circle, className: "text-muted-foreground", label: "" },
  info: { icon: Info, className: "text-muted-foreground", label: "Info" },
  success: { icon: CircleCheck, className: "text-verdict-pass-fg", label: "Success" },
  warning: { icon: TriangleAlert, className: "text-live-reconnecting-fg", label: "Warning" },
  danger: { icon: CircleX, className: "text-verdict-fail-fg", label: "Error" },
} as const satisfies Record<EventTone, TonePresentation>;

export type EventRowProps = {
  row: LogRow;
  expanded: boolean;
  onToggle: (key: string) => void;
  index: number;
  position: number;
  total: number;
  offset: number;
  measureRef: (element: HTMLLIElement | null) => void;
};

export function EventRow({
  row,
  expanded,
  onToggle,
  index,
  position,
  total,
  offset,
  measureRef,
}: EventRowProps) {
  const panelId = useId();
  const { event } = row;
  const description = describeEvent(event);
  const tone = TONE_PRESENTATION[description.tone];
  const ToneIcon = tone.icon;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const json = expanded ? formatEventJson(event) : null;

  return (
    <li
      ref={measureRef}
      data-slot="event-row"
      data-index={index}
      data-event-type={event.type}
      data-seq={event.seq ?? undefined}
      aria-posinset={position}
      aria-setsize={total}
      className="absolute top-0 left-0 w-full border-b"
      style={{ transform: `translateY(${offset}px)` }}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? panelId : undefined}
        onClick={() => onToggle(row.key)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm outline-none hover:bg-muted/50 focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
      >
        <Chevron aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <ToneIcon aria-hidden="true" className={cn("size-3.5 shrink-0", tone.className)} />
        {tone.label === "" ? null : <span className="sr-only">{tone.label}:</span>}
        <time
          dateTime={event.ts}
          title={formatUtc(event.ts) ?? undefined}
          className="w-[4.5rem] shrink-0 font-mono text-xs text-muted-foreground tabular-nums"
        >
          {formatEventClock(event.ts)}
        </time>
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{description.title}</span>
          {description.detail === null ? null : (
            <span className="text-muted-foreground">{` ${description.detail}`}</span>
          )}
        </span>
        {event.seq === null ? (
          <Badge variant="outline">debug</Badge>
        ) : (
          <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
            #{event.seq}
          </span>
        )}
      </button>
      {json === null ? null : (
        <div id={panelId} className="flex flex-col gap-2 border-t bg-muted/30 px-3 py-2">
          <p className="text-sm break-words">
            <span className="font-medium">{description.title}</span>
            {description.detail === null ? null : ` ${description.detail}`}
          </p>
          <pre className="rounded-md border bg-background p-2 font-mono text-xs break-all whitespace-pre-wrap">
            {previewJson(json)}
          </pre>
          <div>
            <CopyButton text={json} subject="event JSON" size="xs" />
          </div>
        </div>
      )}
    </li>
  );
}
