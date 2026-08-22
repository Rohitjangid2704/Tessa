import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-shell/page-header";
import { CoverageSkeleton } from "@/features/coverage/components/coverage-skeleton";
import { CoverageView } from "@/features/coverage/components/coverage-view";

export const metadata: Metadata = { title: "Coverage" };

export default function CoveragePage() {
  return (
    <>
      <PageHeader
        title="Coverage"
        description="See which features, roles and interfaces are tested, fill empty cells from the server and hand the rest to Claude Code."
      />
      <Suspense fallback={<CoverageSkeleton />}>
        <CoverageView />
      </Suspense>
    </>
  );
}
