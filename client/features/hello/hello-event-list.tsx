import { describeEvent, type EventTone } from "@/features/streams/describe-event";
import type { KnownStreamEvent } from "@/features/streams/events";
import { cn } from "@/lib/utils";

const toneClassNames: Record<EventTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  info: "bg-verdict-skipped-bg text-verdict-skipped-fg",
  success: "bg-verdict-pass-bg text-verdict-pass-fg",
  warning: "bg-verdict-flaky-bg text-verdict-flaky-fg",
  danger: "bg-verdict-fail-bg text-verdict-fail-fg",
};

const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  timeZone: "UTC",
});

export function shouldListEvent(event: KnownStreamEvent): boolean {
  return event.type !== "stream.heartbeat";
}

function formatTime(timestamp: string): string {
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? timestamp : `${timeFormatter.format(parsed)} UTC`;
}

export function HelloEventList({ events }: { events: readonly KnownStreamEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="hello-empty">
        No events yet.
      </p>
    );
  }
  return (
    <ol
      aria-label="Run events"
      data-testid="hello-events"
      className="flex flex-col divide-y rounded-lg border"
    >
      {events.map((event, index) => {
        const description = describeEvent(event);
        return (
          <li
            key={`${event.seq ?? "s"}-${event.type}-${index}`}
            data-event-type={event.type}
            data-seq={event.seq ?? undefined}
            className="grid grid-cols-[3.5rem_1fr] items-baseline gap-x-3 gap-y-0.5 px-3 py-2 text-sm sm:grid-cols-[3.5rem_12rem_1fr_auto]"
          >
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {event.seq === null ? "stream" : `#${event.seq}`}
            </span>
            <span className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "rounded-4xl px-2 py-0.5 font-mono text-xs",
                  toneClassNames[description.tone],
                )}
              >
                {event.type}
              </span>
            </span>
            <span className="min-w-0 sm:col-auto">
              <span className="font-medium">{description.title}</span>
              {description.detail !== null ? (
                <span className="text-muted-foreground"> {description.detail}</span>
              ) : null}
            </span>
            <time
              dateTime={event.ts}
              className="col-span-2 text-xs text-muted-foreground tabular-nums sm:col-span-1"
            >
              {formatTime(event.ts)}
            </time>
          </li>
        );
      })}
    </ol>
  );
}
