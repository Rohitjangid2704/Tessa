"use client";

import { useRef, useState, type ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { Textarea } from "@/components/ui/textarea";
import type { CopyOutcome } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

export type PromptCopyBoxProps = {
  text: string;
  label?: string;
  subject?: string;
  className?: string;
  textClassName?: string;
  actions?: ReactNode;
};

export function countLines(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

export function PromptCopyBox({
  text,
  label = "Prompt text",
  subject = "prompt",
  className,
  textClassName,
  actions,
}: PromptCopyBoxProps) {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [blocked, setBlocked] = useState(false);

  function handleOutcome(outcome: CopyOutcome): void {
    setBlocked(outcome === "failed");
    if (outcome === "failed") {
      areaRef.current?.focus();
      areaRef.current?.select();
    }
  }

  return (
    <div data-slot="prompt-copy-box" className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <div className="flex items-center gap-2">
          {actions}
          <CopyButton text={text} subject={subject} onCopyOutcome={handleOutcome} />
        </div>
      </div>
      <Textarea
        ref={areaRef}
        readOnly
        value={text}
        aria-label={label}
        spellCheck={false}
        className={cn("h-72 resize-y font-mono text-xs leading-relaxed", textClassName)}
      />
      <p className="text-xs text-muted-foreground">
        {countLines(text)} lines, {text.length.toLocaleString("en-US")} characters
      </p>
      {blocked ? (
        <p className="text-xs text-destructive">
          Your browser blocked copying. The text is selected: press Ctrl+C to copy it.
        </p>
      ) : null}
    </div>
  );
}
