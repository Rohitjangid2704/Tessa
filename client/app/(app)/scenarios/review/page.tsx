import type { Metadata } from "next";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { ReviewQueue } from "@/features/scenarios/components/review-queue";

export const metadata: Metadata = { title: "Review scenarios" };

function ReviewFallback() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading the review queue</span>
      <Skeleton className="h-8 w-full max-w-3xl" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export default function ScenarioReviewPage() {
  return (
    <Suspense fallback={<ReviewFallback />}>
      <ReviewQueue />
    </Suspense>
  );
}
