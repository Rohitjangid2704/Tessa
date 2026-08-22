import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { RunsTabs } from "@/features/runs/components/runs-tabs";

export const metadata: Metadata = { title: "Runs" };

function RunsListFallback() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading runs</span>
      <Skeleton className="h-8 w-full max-w-xl" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

export default function RunsPage() {
  return (
    <>
      <PageHeader
        title="Runs"
        description="Plans executed against a target. The list updates live as runs start, progress and finish."
      />
      <Suspense fallback={<RunsListFallback />}>
        <RunsTabs />
      </Suspense>
    </>
  );
}
