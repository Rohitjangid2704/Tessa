import type { Metadata } from "next";
import { Suspense } from "react";
import { FindingDetail } from "@/features/findings/components/finding-detail";
import { FindingDetailSkeleton } from "@/features/findings/components/finding-detail-states";

export const metadata: Metadata = { title: "Finding" };

export default async function FindingPage({
  params,
}: {
  params: Promise<{ findingId: string }>;
}) {
  const { findingId } = await params;
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <Suspense fallback={<FindingDetailSkeleton />}>
        <FindingDetail key={findingId} findingId={findingId} variant="page" />
      </Suspense>
    </div>
  );
}
