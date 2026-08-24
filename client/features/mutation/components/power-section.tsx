"use client";

import { useQuery } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";
import { useId } from "react";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { mutationSummaryQuery } from "@/features/home/queries";
import { describeApiError } from "@/lib/api/errors";
import { MUTANTS_PROMPT_ANCHOR } from "../schemas";
import { Headline } from "./headline";
import { PowerChart } from "./power-chart";
import { SurvivorsList } from "./survivors-list";

export type PowerSectionProps = {
  targetId: string;
};

function PowerSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-3">
      <span className="sr-only">Loading the suite power</span>
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

export function PowerSection({ targetId }: PowerSectionProps) {
  const headingId = useId();
  const summary = useQuery(mutationSummaryQuery(targetId));

  function renderBody() {
    if (summary.isPending) {
      return <PowerSkeleton />;
    }
    if (summary.isError) {
      return (
        <ErrorState
          title="Could not load the suite power"
          description={describeApiError(summary.error)}
          requestId={readRequestId(summary.error)}
          onRetry={() => void summary.refetch()}
          className="py-8"
        />
      );
    }
    const { data } = summary;
    if (data.total === 0) {
      return (
        <EmptyState
          icon={FlaskConical}
          title="No known bugs are measured yet"
          description="Copy the Mutants prompt, let Claude Code build one broken branch per bug, deploy each branch to QA, register it here and run it. The suite power appears once a mutant has been run."
          action={
            <Button asChild>
              <a href={`#${MUTANTS_PROMPT_ANCHOR}`}>Copy the Mutants prompt</a>
            </Button>
          }
          className="py-10"
        />
      );
    }
    return (
      <div className="flex flex-col gap-4">
        <Headline summary={data} />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <section aria-label="Power per invariant" className="flex min-w-0 flex-col gap-2">
            <h3 className="text-sm font-medium">Power per invariant</h3>
            <PowerChart rows={data.per_invariant} />
          </section>
          <section aria-label="Survivors" className="flex min-w-0 flex-col gap-2">
            <h3 className="text-sm font-medium">Survivors</h3>
            <SurvivorsList survivors={data.survivors} total={data.total} targetId={targetId} />
          </section>
        </div>
      </div>
    );
  }

  return (
    <section aria-labelledby={headingId} data-slot="power-section" className="flex flex-col gap-3">
      <h2 id={headingId} className="text-base font-semibold">
        Suite power
      </h2>
      {renderBody()}
    </section>
  );
}
