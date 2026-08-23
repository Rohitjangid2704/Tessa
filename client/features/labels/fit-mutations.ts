import { usePatchSettings } from "@/features/settings/mutations";
import { useStartRun } from "@/features/runs/start-mutation";
import { api } from "@/lib/api/client";
import type { CalibrationFitCreate, CalibrationThresholds, RunHandle } from "@/lib/api/types";
import { unwrap } from "@/lib/api/unwrap";

export interface FitCalibrationOptions {
  onStarted?: (handle: RunHandle) => void;
}

export function useFitCalibration(options: FitCalibrationOptions = {}) {
  return useStartRun<CalibrationFitCreate>(
    (body, idempotencyKey) =>
      unwrap(
        api.POST("/api/v1/calibration/fit", {
          params: { header: { "Idempotency-Key": idempotencyKey } },
          body,
        }),
      ),
    { navigate: false, onStarted: options.onStarted },
  );
}

export interface ApplyThresholdsOptions {
  onApplied?: () => void;
}

export function useApplyFitThresholds() {
  const patch = usePatchSettings();

  function apply(thresholds: CalibrationThresholds, options: ApplyThresholdsOptions = {}): void {
    patch.mutate(
      {
        thresholds: {
          probe_confidence: thresholds.probe_confidence,
          judge_escalate_below: thresholds.judge_escalate_below,
        },
      },
      { onSuccess: options.onApplied },
    );
  }

  return { apply, isPending: patch.isPending, error: patch.error, reset: patch.reset };
}
