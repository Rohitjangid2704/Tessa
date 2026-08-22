import type { Metadata } from "next";
import { ScenarioDetail } from "@/features/scenarios/components/scenario-detail";

export const metadata: Metadata = { title: "Scenario" };

export default async function ScenarioPage({ params }: PageProps<"/scenarios/[scenarioId]">) {
  const { scenarioId } = await params;
  return <ScenarioDetail scenarioId={scenarioId} />;
}
