import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { NewTargetButton } from "@/features/targets/components/new-target-button";
import { TargetsList } from "@/features/targets/components/targets-list";

export const metadata: Metadata = { title: "Targets" };

function TargetsListFallback() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading targets</span>
      <Skeleton className="h-8 w-full max-w-xl" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

export default function TargetsPage() {
  return (
    <>
      <PageHeader
        title="Targets"
        description="The apps under test, with their bundles and environment values."
        actions={<NewTargetButton />}
      />
      <Suspense fallback={<TargetsListFallback />}>
        <TargetsList />
      </Suspense>
    </>
  );
}
