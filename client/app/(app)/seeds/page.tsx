import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { SeedsView } from "@/features/seeds/components/seeds-view";

export const metadata: Metadata = { title: "Seeds" };

function SeedsFallback() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading the seed versions</span>
      <Skeleton className="h-6 w-64" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export default function SeedsPage() {
  return (
    <>
      <PageHeader
        title="Seeds"
        description="The reset script and the hash that keep a target's data in a known state. Verify compares the data with the declared hash; reset puts the data back first."
      />
      <Suspense fallback={<SeedsFallback />}>
        <SeedsView />
      </Suspense>
    </>
  );
}
