"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export type TranscriptSide = "start" | "end";

export interface TranscriptEntry {
  key: string;
  speaker: string;
  side: TranscriptSide;
  text: string;
  note?: string;
}

export interface TranscriptProps {
  entries: readonly TranscriptEntry[];
  label: string;
  emptyText?: string;
  followByDefault?: boolean;
  className?: string;
  listClassName?: string;
}

export function Transcript({
  entries,
  label,
  emptyText = "Nothing has been said yet.",
  followByDefault = true,
  className,
  listClassName,
}: TranscriptProps) {
  const followId = useId();
  const announceId = useId();
  const [follow, setFollow] = useState(followByDefault);
  const [announce, setAnnounce] = useState(false);
  const listRef = useRef<HTMLOListElement | null>(null);

  useEffect(() => {
    const list = listRef.current;
    if (follow && list !== null) {
      list.scrollTop = list.scrollHeight;
    }
  }, [follow, entries.length]);

  return (
    <div data-slot="transcript" className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-xs">
        <div className="flex items-center gap-2">
          <Switch id={followId} size="sm" checked={follow} onCheckedChange={setFollow} />
          <Label htmlFor={followId} className="text-xs font-normal">
            Follow new messages
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch id={announceId} size="sm" checked={announce} onCheckedChange={setAnnounce} />
          <Label htmlFor={announceId} className="text-xs font-normal">
            Announce new messages to screen readers
          </Label>
        </div>
      </div>
      <ol
        ref={listRef}
        role="log"
        aria-label={label}
        aria-live={announce ? "polite" : "off"}
        aria-relevant="additions"
        tabIndex={0}
        data-follow={follow}
        className={cn(
          "flex max-h-96 flex-col gap-3 overflow-y-auto rounded-lg border bg-muted/20 p-3 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
          listClassName,
        )}
      >
        {entries.length === 0 ? (
          <li className="text-sm text-muted-foreground">{emptyText}</li>
        ) : (
          entries.map((entry) => (
            <li
              key={entry.key}
              data-side={entry.side}
              className={cn(
                "flex max-w-[85%] flex-col gap-1 rounded-lg border px-3 py-2",
                entry.side === "end" ? "self-end bg-primary/5" : "self-start bg-background",
              )}
            >
              <span className="text-xs font-medium text-muted-foreground">{entry.speaker}</span>
              <span className="text-sm break-words whitespace-pre-wrap">{entry.text}</span>
              {entry.note === undefined ? null : (
                <span className="text-xs text-muted-foreground">{entry.note}</span>
              )}
            </li>
          ))
        )}
      </ol>
    </div>
  );
}
