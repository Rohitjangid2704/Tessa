import { StepDrawer } from "@/features/steps/components/step-drawer";

export default async function StepDrawerPage({
  params,
}: PageProps<"/runs/[runId]/steps/[stepId]">) {
  const { runId, stepId } = await params;
  return <StepDrawer runId={runId} stepId={stepId} />;
}
