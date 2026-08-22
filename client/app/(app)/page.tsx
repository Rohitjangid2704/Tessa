import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { HomeDashboard } from "@/features/home/components/home-dashboard";

export const metadata: Metadata = { title: "Home" };

function HomeFallback() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading the dashboard</span>
      <Skeleton className="h-5 w-48" />
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  );
}

export default function HomePage() {
  return (
    <>
      <PageHeader
        title="Home"
        description="How far to trust the suite: the last nightly, open findings, cost, mutation power and judge agreement."
      />
      <Suspense fallback={<HomeFallback />}>
        <HomeDashboard />
      </Suspense>
    </>
  );
}
