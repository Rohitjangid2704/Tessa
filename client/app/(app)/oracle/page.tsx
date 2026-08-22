import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { OracleView } from "@/features/oracle/components/oracle-view";

export const metadata: Metadata = { title: "Oracle" };

function OracleFallback() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading the oracle templates</span>
      <Skeleton className="h-8 w-full max-w-xl" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export default function OraclePage() {
  return (
    <>
      <PageHeader
        title="Oracle"
        description="Read-only queries from the bundle that compute what an answer should contain. Run one with parameters, check its rows and the sentence it renders, then approve it."
      />
      <Suspense fallback={<OracleFallback />}>
        <OracleView />
      </Suspense>
    </>
  );
}
