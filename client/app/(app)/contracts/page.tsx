import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { ContractsPage } from "@/features/contracts/components/contracts-page";

export const metadata: Metadata = { title: "Contracts" };

function ContractsFallback() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading the contract checks</span>
      <Skeleton className="h-6 w-64" />
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

export default function ContractsRoutePage() {
  return (
    <>
      <PageHeader
        title="Contracts"
        description="Compare two apps before they meet in production: what a consumer says it sends against what a provider says it accepts."
      />
      <Suspense fallback={<ContractsFallback />}>
        <ContractsPage />
      </Suspense>
    </>
  );
}
