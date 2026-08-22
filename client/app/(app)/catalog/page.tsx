import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { PlanWorkspace } from "@/features/plans/components/plan-workspace";

export const metadata: Metadata = { title: "Catalog" };

function CatalogFallback() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading the catalog</span>
      <Skeleton className="h-8 w-full max-w-3xl" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

export default function CatalogPage() {
  return (
    <>
      <PageHeader
        title="Catalog"
        description="Browse the features of a target's latest valid bundle, tick what to test, then run it now or save the plan."
      />
      <Suspense fallback={<CatalogFallback />}>
        <PlanWorkspace />
      </Suspense>
    </>
  );
}
