import type { Metadata } from "next";
import { StepInspector } from "@/features/steps/components/step-inspector";

export const metadata: Metadata = { title: "Step" };

export default async function StepPage({ params }: PageProps<"/runs/[runId]/steps/[stepId]">) {
  const { runId, stepId } = await params;
  return <StepInspector key={stepId} stepId={stepId} runId={runId} variant="page" />;
}
