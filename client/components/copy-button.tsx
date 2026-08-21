"use client";

import { Check, Copy, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { copyToClipboard, type CopyOutcome } from "@/lib/clipboard";

export const COPY_FEEDBACK_MS = 2000;

export type CopyButtonProps = {
  text: string;
  subject?: string;
  variant?: "default" | "outline" | "secondary" | "ghost";
  size?: "default" | "sm" | "xs";
  disabled?: boolean;
  className?: string;
  onCopyOutcome?: (outcome: CopyOutcome) => void;
};

type CopyStatus = CopyOutcome | "idle";

function liveMessage(status: CopyStatus): string {
  if (status === "clipboard" || status === "fallback") {
    return "Copied to clipboard";
  }
  if (status === "failed") {
    return "Copy failed. Select the text and press Ctrl+C";
  }
  return "";
}

export function CopyButton({
  text,
  subject,
  variant = "outline",
  size = "default",
  disabled = false,
  className,
  onCopyOutcome,
}: CopyButtonProps) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  async function copy(): Promise<void> {
    const outcome = await copyToClipboard(text);
    setStatus(outcome);
    onCopyOutcome?.(outcome);
    if (timer.current !== null) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => setStatus("idle"), COPY_FEEDBACK_MS);
  }

  const copied = status === "clipboard" || status === "fallback";
  const failed = status === "failed";
  const Icon = copied ? Check : failed ? TriangleAlert : Copy;

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        disabled={disabled}
        className={className}
        onClick={() => void copy()}
      >
        <Icon aria-hidden="true" data-icon="inline-start" />
        {copied ? (
          "Copied"
        ) : failed ? (
          "Copy failed"
        ) : (
          <>
            Copy{subject ? " " : null}
            {subject ? <span className="sr-only">{subject}</span> : null}
          </>
        )}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {liveMessage(status)}
      </span>
    </>
  );
}
