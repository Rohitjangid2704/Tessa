import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { MutationWorkspace } from "@/features/mutation/components/mutation-workspace";

export const metadata: Metadata = { title: "Mutation" };

function MutationFallback() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading the mutation page</span>
      <Skeleton className="h-6 w-64" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

export default function MutationPage() {
  return (
    <>
      <PageHeader
        title="Mutation"
        description="Measure how far to trust the suite. Known bugs are built as branches, deployed to QA and run against the suite: a bug no invariant catches is a blind spot."
      />
      <Suspense fallback={<MutationFallback />}>
        <MutationWorkspace />
      </Suspense>
    </>
  );
}
