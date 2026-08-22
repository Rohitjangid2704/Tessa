import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { ExploreWorkspace } from "@/features/explore/components/explore-workspace";

export const metadata: Metadata = { title: "Explore" };

function ExploreFallback() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading the explorer</span>
      <Skeleton className="h-6 w-64" />
      <Skeleton className="h-48 w-full max-w-3xl" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

export default function ExplorePage() {
  return (
    <>
      <PageHeader
        title="Explore"
        description="Give an explorer a role and a goal, then watch it try in a real browser. Anything it confirms lands on the findings board with a replayable repro."
      />
      <Suspense fallback={<ExploreFallback />}>
        <ExploreWorkspace />
      </Suspense>
    </>
  );
}
