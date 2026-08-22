import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { ReplayPage } from "@/features/replay/components/replay-page";

export const metadata: Metadata = { title: "Replay" };

function ReplayFallback() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading the replay page</span>
      <Skeleton className="h-6 w-64" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

export default function ReplayRoutePage() {
  return (
    <>
      <PageHeader
        title="Replay"
        description="Turn a production feedback export into candidate cases. Every record becomes a case waiting in the review queue, or a rejected record with the reason it was rejected."
      />
      <Suspense fallback={<ReplayFallback />}>
        <ReplayPage />
      </Suspense>
    </>
  );
}
