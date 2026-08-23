"use client";

import { useNow } from "@/lib/use-now";
import type { IntakeOrigin } from "../use-bundle-intake";

export interface IntakeProgressProps {
  origin: IntakeOrigin;
  startedAt: number | null;
}

export function IntakeProgress({ origin, startedAt }: IntakeProgressProps) {
  const now = useNow(1000);
  const elapsedSeconds =
    now === null || startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
  const subject = origin === "upload" ? "the zip" : "the pasted manifest";

  return (
    <div
      data-slot="intake-progress"
      className="flex flex-col gap-2 rounded-xl border p-4"
      aria-busy="true"
    >
      <p role="status" className="text-sm font-medium">
        Validating {subject}. Nothing else can be uploaded until this finishes.
      </p>
      <div aria-hidden="true" className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full w-full rounded-full bg-primary/60 motion-safe:animate-pulse" />
      </div>
      <p aria-live="off" className="text-xs text-muted-foreground">
        {elapsedSeconds} s elapsed. Validation usually takes a few seconds and can take up to about
        15.
      </p>
    </div>
  );
}
