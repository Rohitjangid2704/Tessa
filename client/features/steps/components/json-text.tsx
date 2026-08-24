"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const JSON_PREVIEW_CHARACTERS = 120;

export interface JsonTextView {
  full: string;
  preview: string;
  isLong: boolean;
  isNull: boolean;
}

export function describeJsonValue(value: unknown): JsonTextView {
  if (value === null || value === undefined) {
    return { full: "null", preview: "null", isLong: false, isNull: true };
  }
  let full: string;
  try {
    full = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    full = String(value);
  }
  const isLong = full.length > JSON_PREVIEW_CHARACTERS;
  return {
    full,
    preview: isLong ? `${full.slice(0, JSON_PREVIEW_CHARACTERS)}…` : full,
    isLong,
    isNull: false,
  };
}

export interface JsonTextProps {
  value: unknown;
  label: string;
  className?: string;
}

export function JsonText({ value, label, className }: JsonTextProps) {
  const regionId = useId();
  const [expanded, setExpanded] = useState(false);
  const view = describeJsonValue(value);
  return (
    <div data-slot="json-text" className={cn("flex min-w-0 flex-col items-start gap-1", className)}>
      <pre
        id={regionId}
        className={cn(
          "max-w-full font-mono text-xs break-words whitespace-pre-wrap",
          view.isNull && "text-muted-foreground italic",
        )}
      >
        {expanded ? view.full : view.preview}
      </pre>
      {view.isLong ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto p-0 text-xs"
          aria-expanded={expanded}
          aria-controls={regionId}
          aria-label={`${expanded ? "Show less" : "Show more"} of ${label}`}
          onClick={() => setExpanded((previous) => !previous)}
        >
          {expanded ? "Show less" : "Show more"}
        </Button>
      ) : null}
    </div>
  );
}
