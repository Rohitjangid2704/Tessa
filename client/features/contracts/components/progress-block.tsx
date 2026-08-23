"use client";

import { LoaderCircle } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { useThrottledValue } from "@/lib/use-throttled-value";
import { describeProgress, progressPercent, type CheckProgress } from "../model";

export const ANNOUNCEMENT_INTERVAL_MS = 2000;

export type ProgressBlockProps = { progress: CheckProgress };

export function ProgressBlock({ progress }: ProgressBlockProps) {
  const percent = progressPercent(progress);
  const message = describeProgress(progress);
  const announced = useThrottledValue(message, ANNOUNCEMENT_INTERVAL_MS);

  return (
    <section
      aria-label="Check progress"
      data-slot="contract-progress"
      className="flex flex-col gap-2 rounded-lg border p-3"
    >
      <p className="flex items-center gap-2 text-sm">
        <LoaderCircle
          aria-hidden="true"
          className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
        />
        <span>{message}</span>
      </p>
      {percent === null ? null : (
        <Progress value={percent} aria-label="Items compared" className="h-2" />
      )}
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announced}
      </p>
    </section>
  );
}
