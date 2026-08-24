"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { runsTabCodec, RUNS_TABS, type RunsTab } from "@/features/trends/schemas";
import { TrendsPanel } from "@/features/trends/trends-panel";
import { useUrlFilters } from "@/lib/url-state";
import { RunsListView } from "./runs-list-view";

function readRunsTab(value: string): RunsTab | undefined {
  return RUNS_TABS.find((tab) => tab === value);
}

export function RunsTabs() {
  const { values, setFilters } = useUrlFilters(runsTabCodec);
  const current: RunsTab = values.tab ?? "runs";

  function selectTab(value: string): void {
    const tab = readRunsTab(value);
    if (tab !== undefined) {
      setFilters({ tab: tab === "runs" ? undefined : tab }, { history: "push" });
    }
  }

  return (
    <Tabs data-slot="runs-tabs" value={current} onValueChange={selectTab} className="gap-4">
      <TabsList aria-label="Runs views">
        <TabsTrigger value="runs">Runs</TabsTrigger>
        <TabsTrigger value="trends">Trends</TabsTrigger>
      </TabsList>
      <TabsContent value="runs" className="text-base">
        <RunsListView />
      </TabsContent>
      <TabsContent value="trends" className="text-base">
        <TrendsPanel />
      </TabsContent>
    </Tabs>
  );
}
