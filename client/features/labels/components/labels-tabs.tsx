"use client";

import { RoleGate } from "@/components/role-gate";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useUrlFilters } from "@/lib/url-state";
import { DEFAULT_LABELS_TAB, labelsTabCodec, readLabelsTab, type LabelsTab } from "../tab-schemas";
import { CalibrationTable } from "./calibration-table";
import { ExportTab } from "./export-tab";
import { LabelQueue } from "./label-queue";

export function LabelsTabs() {
  const { values, setFilters } = useUrlFilters(labelsTabCodec);
  const current: LabelsTab = values.tab ?? DEFAULT_LABELS_TAB;

  function selectTab(value: string): void {
    const tab = readLabelsTab(value);
    if (tab !== undefined) {
      setFilters({ tab: tab === DEFAULT_LABELS_TAB ? undefined : tab }, { history: "push" });
    }
  }

  return (
    <Tabs data-slot="labels-tabs" value={current} onValueChange={selectTab} className="gap-4">
      <TabsList aria-label="Labels views">
        <TabsTrigger value="queue">Review queue</TabsTrigger>
        <TabsTrigger value="calibration">Calibration</TabsTrigger>
        <RoleGate action="labels.export">
          <TabsTrigger value="export">Export and fit</TabsTrigger>
        </RoleGate>
      </TabsList>
      <TabsContent value="queue" className="text-base">
        <LabelQueue />
      </TabsContent>
      <TabsContent value="calibration" className="text-base">
        <CalibrationTable />
      </TabsContent>
      <TabsContent value="export" className="text-base">
        <ExportTab />
      </TabsContent>
    </Tabs>
  );
}
