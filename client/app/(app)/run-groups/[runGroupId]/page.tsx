import type { Metadata } from "next";
import { PageHeader } from "@/components/app-shell/page-header";
import { RunGroupPanel } from "@/features/runs/components/run-group-panel";

export const metadata: Metadata = { title: "Run group" };

export default async function RunGroupPage({ params }: PageProps<"/run-groups/[runGroupId]">) {
  const { runGroupId } = await params;
  return (
    <>
      <PageHeader
        title="Run group"
        description="One plan per target, started together. Each member run keeps its own page and results."
      />
      <RunGroupPanel key={runGroupId} runGroupId={runGroupId} />
    </>
  );
}
