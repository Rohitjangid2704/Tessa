"use client";

import { useState, type ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { RunKind } from "@/lib/api/types";
import type { RunDetailTab } from "@/lib/routes";
import { useMediaQuery } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import { useRunStreamState } from "../use-run-stream";
import { EventLog } from "./event-log";
import { RunResults } from "./run-results";
import { RunTabs } from "./run-tabs";
import { ScenarioList } from "./scenario-list";
import { SessionTiles } from "./session-tiles";

export const RUN_BODY_TABS_BELOW_PX = 900;

export const DEFAULT_RUN_BODY_KIND: RunKind = "suite";

export interface RunBodySection {
  id: string;
  label: string;
  span: "full" | "half";
  tab?: RunDetailTab;
  appliesTo?: (kind: RunKind) => boolean;
  render: (runId: string) => ReactNode;
}

export const RUN_BODY_SECTIONS: readonly RunBodySection[] = [
  {
    id: "tiles",
    label: "Tiles",
    span: "full",
    tab: "live",
    render: (runId) => <SessionTiles runId={runId} />,
  },
  {
    id: "scenarios",
    label: "Scenarios",
    span: "half",
    tab: "scenarios",
    render: (runId) => <ScenarioList runId={runId} />,
  },
  {
    id: "events",
    label: "Events",
    span: "half",
    tab: "live",
    render: (runId) => <EventLog runId={runId} />,
  },
  {
    id: "results",
    label: "Results",
    span: "full",
    tab: "results",
    render: (runId) => <RunResults runId={runId} />,
  },
];

export function sectionsForKind(
  sections: readonly RunBodySection[],
  kind: RunKind,
): readonly RunBodySection[] {
  return sections.filter((section) => section.appliesTo === undefined || section.appliesTo(kind));
}

export type RunBodyProps = {
  runId: string;
  sections?: readonly RunBodySection[];
};

export function RunBody({ runId, sections = RUN_BODY_SECTIONS }: RunBodyProps) {
  const { run } = useRunStreamState();
  const visible = sectionsForKind(sections, run?.kind ?? DEFAULT_RUN_BODY_KIND);
  if (visible.every((section) => section.tab !== undefined)) {
    return <RunTabs runId={runId} sections={visible} />;
  }
  return <RunSections runId={runId} visible={visible} />;
}

type RunSectionsProps = {
  runId: string;
  visible: readonly RunBodySection[];
};

function RunSections({ runId, visible }: RunSectionsProps) {
  const wide = useMediaQuery(`(min-width: ${RUN_BODY_TABS_BELOW_PX}px)`, true);
  const [activeTab, setActiveTab] = useState(visible[0]?.id ?? "");
  const currentTab = visible.some((section) => section.id === activeTab)
    ? activeTab
    : (visible[0]?.id ?? "");

  if (wide) {
    return (
      <div data-slot="run-body" data-layout="stacked" className="grid grid-cols-2 gap-6">
        {visible.map((section) => (
          <div
            key={section.id}
            data-section={section.id}
            className={cn("min-w-0", section.span === "full" && "col-span-2")}
          >
            {section.render(runId)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <Tabs
      data-slot="run-body"
      data-layout="tabs"
      value={currentTab}
      onValueChange={setActiveTab}
      className="gap-4"
    >
      <TabsList aria-label="Run sections" className="w-full justify-start overflow-x-auto">
        {visible.map((section) => (
          <TabsTrigger key={section.id} value={section.id}>
            {section.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {visible.map((section) => (
        <TabsContent
          key={section.id}
          value={section.id}
          forceMount
          data-section={section.id}
          className="min-w-0 data-[state=inactive]:hidden"
        >
          {section.render(runId)}
        </TabsContent>
      ))}
    </Tabs>
  );
}
