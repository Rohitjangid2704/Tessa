"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CurrentTargetGate } from "@/features/targets/current-target-gate";
import type { SimulatorTab } from "@/lib/routes";
import { useUrlFilters } from "@/lib/url-state";
import { DEFAULT_SIMULATOR_TAB, SIMULATOR_TAB_LABELS, SIMULATOR_TABS, simulatorsCodec } from "../schemas";
import { GoalTable } from "./goal-table";
import { PersonaTable } from "./persona-table";
import { SimulationsPanel } from "./simulations-panel";

function isSimulatorTab(value: string): value is SimulatorTab {
  return (SIMULATOR_TABS as readonly string[]).includes(value);
}

export interface SimulatorsWorkspaceProps {
  targetId: string;
}

export function SimulatorsWorkspace({ targetId }: SimulatorsWorkspaceProps) {
  const filters = useUrlFilters(simulatorsCodec);
  const tab = filters.values.tab ?? DEFAULT_SIMULATOR_TAB;

  function selectTab(next: string): void {
    if (isSimulatorTab(next)) {
      filters.setFilters(
        { tab: next, q: undefined, kind: undefined, session: undefined },
        { history: "push" },
      );
    }
  }

  return (
    <Tabs value={tab} onValueChange={selectTab} className="gap-6">
      <TabsList aria-label="Simulator sections">
        {SIMULATOR_TABS.map((value) => (
          <TabsTrigger key={value} value={value}>
            {SIMULATOR_TAB_LABELS[value]}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="personas">
        <PersonaTable targetId={targetId} />
      </TabsContent>
      <TabsContent value="goals">
        <GoalTable targetId={targetId} />
      </TabsContent>
      <TabsContent value="simulations">
        <SimulationsPanel targetId={targetId} />
      </TabsContent>
    </Tabs>
  );
}

export function SimulatorsView() {
  return (
    <CurrentTargetGate
      title="Choose a target"
      description="Personas, goals and simulations belong to one target. Pick one to continue."
    >
      {(targetId) => <SimulatorsWorkspace key={targetId} targetId={targetId} />}
    </CurrentTargetGate>
  );
}
