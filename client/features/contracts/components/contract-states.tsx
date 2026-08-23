import { GitCompareArrows } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/states/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { contractRoutes } from "@/lib/routes";

export function ContractDiffSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      data-slot="contract-diff-skeleton"
      className="flex flex-col gap-6"
    >
      <span className="sr-only">Loading the contract check</span>
      <Skeleton className="h-36 w-full rounded-xl" />
      <Skeleton className="h-8 w-72" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export function ContractNotFound() {
  return (
    <EmptyState
      data-slot="contract-not-found"
      icon={GitCompareArrows}
      title="Contract check not found"
      description="This check does not exist, or its link is not valid. It may have been removed."
      action={
        <Button asChild variant="outline">
          <Link href={contractRoutes.list()}>Back to the contract checks</Link>
        </Button>
      }
    />
  );
}
