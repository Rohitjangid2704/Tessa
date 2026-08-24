"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  markSegments,
  truncateSegments,
  type MarkKind,
  type Needle,
  type Segment,
} from "../evidence-marking";

export const TEXT_PREVIEW_CHARS = 480;

export const MARK_CLASSES: Record<MarkKind, string> = {
  gold:
    "bg-tier-code-bg text-tier-code-fg underline decoration-solid decoration-2 underline-offset-2",
  forbidden:
    "bg-severity-critical-bg text-severity-critical-fg underline decoration-wavy decoration-2 underline-offset-2",
  unsupported:
    "bg-severity-medium-bg text-severity-medium-fg underline decoration-dotted decoration-2 underline-offset-2",
};

export const MARK_SPOKEN: Record<MarkKind, string> = {
  gold: "gold point",
  forbidden: "must not claim",
  unsupported: "unsupported claim",
};

export type ExpandableTextProps = {
  text: string;
  needles?: readonly Needle[];
  previewChars?: number;
  mono?: boolean;
  className?: string;
};

function renderSegment(segment: Segment, index: number) {
  if (segment.kind === null) {
    return segment.text;
  }
  return (
    <mark
      key={index}
      data-kind={segment.kind}
      className={cn("rounded-sm px-0.5", MARK_CLASSES[segment.kind])}
    >
      <span className="sr-only">{MARK_SPOKEN[segment.kind]}: </span>
      {segment.text}
    </mark>
  );
}

export function ExpandableText({
  text,
  needles = [],
  previewChars = TEXT_PREVIEW_CHARS,
  mono = false,
  className,
}: ExpandableTextProps) {
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const truncates = text.length > previewChars;
  const segments = markSegments(text, needles);
  const shown = truncates && !expanded ? truncateSegments(segments, previewChars) : segments;

  return (
    <div className={cn("flex flex-col items-start gap-1.5", className)}>
      <p
        id={bodyId}
        data-slot="expandable-text"
        data-expanded={expanded}
        className={cn(
          "max-h-96 w-full overflow-y-auto rounded-lg bg-muted/50 p-3 text-sm wrap-break-word whitespace-pre-wrap",
          mono && "font-mono text-xs",
        )}
      >
        {shown.map((segment, index) => renderSegment(segment, index))}
        {truncates && !expanded ? "..." : null}
      </p>
      {truncates ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Show less" : `Show all ${text.length} characters`}
        </Button>
      ) : null}
    </div>
  );
}
