"use client";

import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { formatCount } from "@/features/steps/format";
import { cn } from "@/lib/utils";

export const TEXT_PREVIEW_LIMIT = 2000;
export const INLINE_TEXT_LIMIT = 300;

function useTruncation(text: string, limit: number) {
  const [expanded, setExpanded] = useState(false);
  const isCut = text.length > limit;
  return {
    isCut,
    expanded,
    shown: isCut && !expanded ? `${text.slice(0, limit)}...` : text,
    toggle: () => setExpanded((current) => !current),
    toggleLabel: expanded ? "Show less" : `Show all ${formatCount(text.length)} characters`,
  };
}

export interface TruncatedTextProps {
  text: string;
  limit?: number;
  className?: string;
}

export function TruncatedText({ text, limit = INLINE_TEXT_LIMIT, className }: TruncatedTextProps) {
  const { isCut, expanded, shown, toggle, toggleLabel } = useTruncation(text, limit);
  return (
    <span data-slot="truncated-text" className={cn("min-w-0", className)}>
      <span className="wrap-anywhere whitespace-pre-wrap">{shown}</span>
      {isCut ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          onClick={toggle}
          className="ml-1 h-auto p-0 text-xs"
        >
          {toggleLabel}
        </Button>
      ) : null}
    </span>
  );
}

export interface TextViewProps {
  text: string;
  label: string;
  limit?: number;
  className?: string;
}

export function TextView({ text, label, limit = TEXT_PREVIEW_LIMIT, className }: TextViewProps) {
  const { isCut, expanded, shown, toggle, toggleLabel } = useTruncation(text, limit);
  return (
    <div
      role="group"
      aria-label={label}
      data-slot="text-view"
      className={cn("flex min-w-0 flex-col gap-1", className)}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <CopyButton text={text} subject={label} variant="ghost" size="xs" />
      </div>
      <pre
        tabIndex={expanded ? 0 : undefined}
        className={cn(
          "wrap-anywhere rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs whitespace-pre-wrap",
          expanded && "max-h-128 overflow-auto",
        )}
      >
        {shown}
      </pre>
      {isCut ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          onClick={toggle}
          className="h-auto self-start p-0 text-xs"
        >
          {toggleLabel}
        </Button>
      ) : null}
    </div>
  );
}
