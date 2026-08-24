"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { ShieldAlert, TriangleAlert } from "lucide-react";
import { useId } from "react";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { isTargetNotFound, useTarget } from "@/features/targets/queries";
import { CurrentTargetGate } from "@/features/targets/current-target-gate";
import type { Target } from "@/features/targets/types";
import { describeApiError } from "@/lib/api/errors";
import { mutantsQuery } from "../queries";
import { ARCHIVED_TARGET_REASON, PRODUCTION_RUN_BLOCKED_REASON } from "../schemas";
import type { Mutant } from "../types";
import { useLatestBundle } from "../use-latest-bundle";
import { HistoryList } from "./history-list";
import { HooksPromptCard } from "./hooks-prompt-card";
import { LastRunPanel } from "./last-run-panel";
import { MutantTable } from "./mutant-table";
import { MutantsPromptCard } from "./mutants-prompt-card";
import { PowerSection } from "./power-section";
import { WorkflowChecklist } from "./workflow-checklist";

const NO_MUTANTS: readonly Mutant[] = [];

function WorkspaceSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading the mutation page</span>
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

function TargetBanners({ target }: { target: Target }) {
  const archived = target.archived_at !== null && target.archived_at !== undefined;
  if (!archived && target.tier !== "production") {
    return null;
  }
  return (
    <div data-slot="target-banners" className="flex flex-col gap-3">
      {archived ? (
        <Alert role="status" data-slot="archived-banner">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>This target is archived</AlertTitle>
          <AlertDescription>{ARCHIVED_TARGET_REASON}</AlertDescription>
        </Alert>
      ) : null}
      {target.tier === "production" ? (
        <Alert role="status" data-slot="production-banner">
          <ShieldAlert aria-hidden="true" />
          <AlertTitle>This is a production target</AlertTitle>
          <AlertDescription>{PRODUCTION_RUN_BLOCKED_REASON}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function MutationWorkspaceBody({ target }: { target: Target }) {
  const catalogueHeadingId = useId();
  const mutants = useInfiniteQuery(mutantsQuery(target.id));
  const bundle = useLatestBundle(target.id);
  const items = mutants.data?.items ?? NO_MUTANTS;
  const hooks = bundle.bundle?.hooks_missing ?? [];

  return (
    <div data-slot="mutation-workspace" className="flex flex-col gap-10">
      <TargetBanners target={target} />
      <PowerSection targetId={target.id} />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <WorkflowChecklist
          targetId={target.id}
          mutants={mutants.isPending ? null : items}
        />
        <div className="flex min-w-0 flex-col gap-6">
          <MutantsPromptCard target={target} />
          {bundle.bundle === null || hooks.length === 0 ? null : (
            <HooksPromptCard
              target={target}
              bundleId={bundle.bundle.id}
              bundleVersion={bundle.bundle.version}
              hooks={hooks}
            />
          )}
        </div>
      </div>
      <section aria-labelledby={catalogueHeadingId} className="flex flex-col gap-3">
        <h2 id={catalogueHeadingId} className="text-base font-semibold">
          Mutants
        </h2>
        <MutantTable target={target} />
      </section>
      <LastRunPanel targetId={target.id} mutants={items} />
      <HistoryList targetId={target.id} mutants={items} />
    </div>
  );
}

function MutationWorkspaceForTarget({ targetId }: { targetId: string }) {
  const target = useTarget(targetId);

  if (target.isPending) {
    return <WorkspaceSkeleton />;
  }
  if (target.isError) {
    if (isTargetNotFound(target.error)) {
      return (
        <EmptyState
          title="Target not found"
          description="This target does not exist or was removed. Pick another one from the switcher."
        />
      );
    }
    return (
      <ErrorState
        title="Could not load the target"
        description={describeApiError(target.error)}
        requestId={readRequestId(target.error)}
        onRetry={() => void target.refetch()}
      />
    );
  }
  return <MutationWorkspaceBody target={target.data} />;
}

export function MutationWorkspace() {
  return (
    <CurrentTargetGate
      title="Choose a target to measure"
      description="Mutation power is measured one target at a time: how many known bugs its suite catches. Pick a target to continue."
    >
      {(targetId) => <MutationWorkspaceForTarget key={targetId} targetId={targetId} />}
    </CurrentTargetGate>
  );
}
