import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { FindingsView } from "@/features/findings/components/findings-view";

export const metadata: Metadata = { title: "Findings" };

function FindingsFallback() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading findings</span>
      <Skeleton className="h-8 w-full max-w-3xl" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export default function FindingsPage() {
  return (
    <>
      <PageHeader
        title="Findings"
        description="Failures grouped by fingerprint and triaged from new to resolved. Move a finding with the menu on its card; new findings arrive live."
      />
      <Suspense fallback={<FindingsFallback />}>
        <FindingsView />
      </Suspense>
    </>
  );
}
