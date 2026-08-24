"use client";

import { Scale } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { CalibrationFitResult } from "@/features/labels/components/calibration-fit-result";
import { useCalibrationFit } from "@/features/labels/fit-queries";
import { labelRoutes } from "@/lib/routes";
import { EventLog } from "../components/event-log";

export type CalibrationViewProps = { runId: string };

export function CalibrationView({ runId }: CalibrationViewProps) {
  const headingId = useId();
  const fit = useCalibrationFit(runId);

  return (
    <div data-slot="calibration-view" className="flex flex-col gap-6">
      <section aria-labelledby={headingId} className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id={headingId} className="flex items-center gap-2 text-base font-semibold">
            <Scale aria-hidden="true" className="size-4" />
            Calibration fit
          </h2>
          <Button asChild variant="outline" size="sm">
            <Link href={labelRoutes.tab("export", { fit: runId })}>Back to export and fit</Link>
          </Button>
        </div>
        <CalibrationFitResult runId={runId} fit={fit} showRunLink={false} />
      </section>
      <EventLog runId={runId} />
    </div>
  );
}
