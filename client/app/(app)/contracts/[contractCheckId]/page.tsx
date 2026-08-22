import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/app-shell/page-header";
import { Button } from "@/components/ui/button";
import { ContractDiffView } from "@/features/contracts/components/contract-diff-view";
import { ContractDiffSkeleton } from "@/features/contracts/components/contract-states";
import { contractRoutes } from "@/lib/routes";

export const metadata: Metadata = { title: "Contract check" };

export default async function ContractCheckPage({
  params,
}: {
  params: Promise<{ contractCheckId: string }>;
}) {
  const { contractCheckId } = await params;
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col">
      <PageHeader
        title="Contract check"
        description="What the consumer says it sends, compared with what the provider says it accepts."
        actions={
          <Button asChild variant="outline">
            <Link href={contractRoutes.list()}>All contract checks</Link>
          </Button>
        }
      />
      <Suspense fallback={<ContractDiffSkeleton />}>
        <ContractDiffView key={contractCheckId} contractCheckId={contractCheckId} />
      </Suspense>
    </div>
  );
}
