"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatCount, formatOffset } from "@/features/steps/format";
import type { SseStepEvent } from "@/lib/api/types";
import { EmptyNote } from "./step-section";
import { TruncatedText } from "./text-view";

export const SSE_PAGE_SIZE = 50;

export function SseEventList({ events }: { events: readonly SseStepEvent[] }) {
  const [visible, setVisible] = useState(SSE_PAGE_SIZE);

  if (events.length === 0) {
    return <EmptyNote compact>The stream sent no events.</EmptyNote>;
  }

  const shown = events.slice(0, visible);
  const hidden = events.length - shown.length;

  return (
    <div className="flex flex-col gap-2">
      <ol data-slot="sse-events" className="divide-y rounded-md border text-xs">
        {shown.map((event, index) => (
          <li
            key={index}
            className="flex flex-col gap-0.5 px-3 py-1.5 sm:grid sm:grid-cols-[5rem_8rem_minmax(0,1fr)] sm:gap-x-3"
          >
            <span className="tabular-nums text-muted-foreground">{formatOffset(event.at_ms)}</span>
            <span className="wrap-anywhere font-mono font-medium">{event.event ?? "message"}</span>
            <TruncatedText text={event.data} className="font-mono" />
          </li>
        ))}
      </ol>
      {hidden > 0 ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => setVisible((current) => current + SSE_PAGE_SIZE)}
        >
          {`Show ${formatCount(Math.min(hidden, SSE_PAGE_SIZE))} more of ${formatCount(hidden)} hidden events`}
        </Button>
      ) : null}
    </div>
  );
}
