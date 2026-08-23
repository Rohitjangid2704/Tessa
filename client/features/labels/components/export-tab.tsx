"use client";

import { PageGate } from "@/components/page-gate";
import { CalibrationFitPanel } from "./calibration-fit-panel";
import { ExportPanel } from "./export-panel";

export function ExportTab() {
  return (
    <PageGate action="labels.export">
      <div data-slot="labels-export-tab" className="flex flex-col gap-6">
        <ExportPanel />
        <CalibrationFitPanel />
      </div>
    </PageGate>
  );
}
