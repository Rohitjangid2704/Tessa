import type { Metadata } from "next";
import { RunDiffScreen } from "@/features/runs/components/run-diff";

export const metadata: Metadata = { title: "Run diff" };

export default async function RunDiffPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return <RunDiffScreen runId={runId} />;
}
