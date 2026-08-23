"use client";

import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { RequiresPermission } from "@/components/requires-permission";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatCount } from "@/features/runs/results-format";
import { TargetFilterSelect } from "@/features/targets/components/target-filter-select";
import { describeApiError } from "@/lib/api/errors";
import { isRunTerminal } from "@/lib/api/polling";
import { useUrlFilters } from "@/lib/url-state";
import { isExportReady, LABEL_EXPORT_MIN_COUNT } from "../export-model";
import { labelExportStatsQuery } from "../export-queries";
import { useFitCalibration } from "../fit-mutations";
import { useCalibrationFit } from "../fit-queries";
import { calibrationFitCodec } from "../tab-schemas";
import { CalibrationFitResult } from "./calibration-fit-result";

export function CalibrationFitPanel() {
  const headingId = useId();
  const { values, setFilters } = useUrlFilters(calibrationFitCodec);
  const runId = values.fit ?? null;
  const [scopeTargetId, setScopeTargetId] = useState<string | undefined>(undefined);
  const stats = useQuery(labelExportStatsQuery());
  const fit = useCalibrationFit(runId);
  const start = useFitCalibration({
    onStarted: (handle) => setFilters({ fit: handle.run_id }, { history: "push" }),
  });

  const busy =
    runId !== null && (fit.data === undefined ? fit.isPending : !isRunTerminal(fit.data));
  const totalHuman = stats.data?.total_human;
  const fewLabelCount = totalHuman !== undefined && !isExportReady(totalHuman) ? totalHuman : null;
  const startRequestId = readRequestId(start.error);

  function startFit(): void {
    start.start({ target_id: scopeTargetId ?? null });
  }

  return (
    <section
      aria-labelledby={headingId}
      data-slot="calibration-fit"
      data-busy={busy ? "true" : "false"}
      className="flex max-w-3xl flex-col gap-4 rounded-xl border p-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-base font-semibold">
          Calibration fit
        </h2>
        <p className="text-sm text-muted-foreground">
          Fits the probe temperatures and the two thresholds from your labels. It holds some labels
          out and compares kappa before and after on them. The server adopts the fit by itself only
          when kappa improves, otherwise it stays a proposal. It does not fine-tune a model.
        </p>
      </div>
      {fewLabelCount === null ? null : (
        <p data-slot="fit-few-labels" className="text-sm text-muted-foreground">
          Only {formatCount(fewLabelCount)} human labels exist so far. A fit on fewer than{" "}
          {formatCount(LABEL_EXPORT_MIN_COUNT)} is noisy and may finish without a proposal.
        </p>
      )}
      <div className="flex flex-wrap items-end gap-4">
        <TargetFilterSelect value={scopeTargetId} onChange={setScopeTargetId} />
        <RequiresPermission action="calibration.fit">
          {({ disabled }) => (
            <Button
              type="button"
              disabled={disabled || busy || start.isPending}
              onClick={startFit}
              data-slot="fit-start"
            >
              {start.isPending ? "Starting the fit" : busy ? "Fit running" : "Fit calibration"}
            </Button>
          )}
        </RequiresPermission>
      </div>
      {start.error === null ? null : (
        <Alert variant="destructive" data-slot="fit-start-error">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Could not start the fit</AlertTitle>
          <AlertDescription>
            {describeApiError(start.error)}
            {startRequestId === null ? "" : ` (request ${startRequestId})`}
          </AlertDescription>
        </Alert>
      )}
      {runId === null ? (
        <p data-slot="fit-empty" className="text-sm text-muted-foreground">
          No fit has run yet. Start one to see its proposal here.
        </p>
      ) : (
        <CalibrationFitResult runId={runId} fit={fit} />
      )}
    </section>
  );
}
