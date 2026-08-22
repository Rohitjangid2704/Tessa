import type { Metadata } from "next";
import { RunScreen } from "@/features/runs/components/run-screen";

export const metadata: Metadata = { title: "Run" };

export default async function RunPage({ params }: PageProps<"/runs/[runId]">) {
  const { runId } = await params;
  return <RunScreen runId={runId} />;
}
