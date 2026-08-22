import { RunScreen } from "@/features/runs/components/run-screen";

export default async function RunDefault({ params }: PageProps<"/runs/[runId]">) {
  const { runId } = await params;
  return <RunScreen runId={runId} />;
}
