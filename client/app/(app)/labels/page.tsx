import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { LabelsTabs } from "@/features/labels/components/labels-tabs";

export const metadata: Metadata = { title: "Labels" };

function LabelsFallback() {
  return (
    <div role="status" aria-busy="true" className="flex max-w-3xl flex-col gap-4">
      <span className="sr-only">Loading labels</span>
      <Skeleton className="h-6 w-72" />
      <Skeleton className="h-28 w-full" />
    </div>
  );
}

export default function LabelsPage() {
  return (
    <>
      <PageHeader
        title="Labels"
        description="Settle the grades the machine could not. One card at a time, keyboard first: p pass, f fail, u uncertain, s skip, o open the step, z undo, ? for help."
      />
      <Suspense fallback={<LabelsFallback />}>
        <LabelsTabs />
      </Suspense>
    </>
  );
}
