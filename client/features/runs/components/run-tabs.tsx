"use client";

import { Suspense, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { RunDetailTab } from "@/lib/routes";
import { useUrlFilters } from "@/lib/url-state";
import { isTerminalRunStatus } from "../run-status";
import {
  readRunTab,
  RUN_TAB_KEPT_MOUNTED,
  RUN_TAB_LABELS,
  RUN_TABS,
  runTabCodec,
} from "../tab-schemas";
import { useRunStreamState } from "../use-run-stream";
import type { RunBodySection } from "./run-body";

export type RunTabsProps = {
  runId: string;
  sections: readonly RunBodySection[];
};

function RunTabsFallback() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading the run sections</span>
      <Skeleton className="h-8 w-72 max-w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function RunTabsContent({ runId, sections }: RunTabsProps) {
  const { run } = useRunStreamState();
  const [openedTerminal] = useState(() => run !== undefined && isTerminalRunStatus(run.status));
  const { values, setFilters } = useUrlFilters(runTabCodec);
  const available = RUN_TABS.filter((tab) => sections.some((section) => section.tab === tab));
  const requested: RunDetailTab = values.tab ?? (openedTerminal ? "results" : "live");
  const current = available.includes(requested) ? requested : (available[0] ?? "live");

  function selectTab(value: string): void {
    const tab = readRunTab(value);
    if (tab !== undefined) {
      setFilters({ tab }, { history: "push" });
    }
  }

  return (
    <Tabs
      data-slot="run-body"
      data-layout="tabs"
      data-tab={current}
      value={current}
      onValueChange={selectTab}
      className="gap-4"
    >
      <TabsList aria-label="Run sections" className="w-full justify-start overflow-x-auto">
        {available.map((tab) => (
          <TabsTrigger key={tab} value={tab}>
            {RUN_TAB_LABELS[tab]}
          </TabsTrigger>
        ))}
      </TabsList>
      {available.map((tab) => (
        <TabsContent
          key={tab}
          value={tab}
          forceMount={RUN_TAB_KEPT_MOUNTED[tab] ? true : undefined}
          data-tab-panel={tab}
          className="min-w-0 data-[state=inactive]:hidden"
        >
          <div className="flex flex-col gap-6">
            {sections
              .filter((section) => section.tab === tab)
              .map((section) => (
                <div key={section.id} data-section={section.id} className="min-w-0">
                  {section.render(runId)}
                </div>
              ))}
          </div>
        </TabsContent>
      ))}
    </Tabs>
  );
}

export function RunTabs(props: RunTabsProps) {
  return (
    <Suspense fallback={<RunTabsFallback />}>
      <RunTabsContent {...props} />
    </Suspense>
  );
}
