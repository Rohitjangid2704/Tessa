"use client";

import { GitBranch } from "lucide-react";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import { useCanDo } from "@/lib/auth/can";
import { useGitSource } from "../use-git-source";
import { GitSourceForm } from "./git-source-form";
import { GitSourceSummary } from "./git-source-summary";
import { ImportRunStatus } from "./import-run-status";
import { PullFromGitButton } from "./pull-from-git-button";

export const GIT_SOURCE_READ_ONLY_REASON =
  "You have read-only access. Members and admins can change the git source and pull from it.";
export const GIT_SOURCE_CHECKING_REASON = "Checking your access.";

export type GitSourcePanelProps = {
  targetId: string;
};

function PanelSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-3">
      <span className="sr-only">Loading the git source</span>
      <Skeleton className="h-5 w-72 max-w-full" />
      <Skeleton className="h-9 w-full max-w-2xl" />
      <Skeleton className="h-9 w-full max-w-2xl" />
    </div>
  );
}

export function GitSourcePanel({ targetId }: GitSourcePanelProps) {
  const sourceAccess = useCanDo("bundles.source_write");
  const { query, source, isPending, isError } = useGitSource(targetId);

  if (isPending) {
    return <PanelSkeleton />;
  }

  if (isError || source === undefined) {
    return (
      <ErrorState
        title="Could not load the git source"
        description={describeApiError(query.error)}
        requestId={readRequestId(query.error)}
        onRetry={() => void query.refetch()}
        className="py-8"
      />
    );
  }

  const readOnlyReason = sourceAccess.isPending
    ? GIT_SOURCE_CHECKING_REASON
    : sourceAccess.allowed
      ? null
      : GIT_SOURCE_READ_ONLY_REASON;

  return (
    <div
      data-slot="git-source-panel"
      data-configured={source !== null}
      className="flex flex-col gap-6"
    >
      {source === null ? (
        <EmptyState
          title="No git source yet"
          description={
            readOnlyReason === null
              ? "Fill in the repository, branch and credential below, then pull the tessa folder as a new bundle version."
              : "A member or admin can set up a repository here to pull the tessa folder as a new bundle version."
          }
          icon={GitBranch}
          className="py-10"
        />
      ) : (
        <GitSourceSummary source={source} />
      )}
      <GitSourceForm
        key={targetId}
        targetId={targetId}
        source={source}
        readOnlyReason={readOnlyReason}
      />
      <PullFromGitButton key={`pull-${targetId}`} targetId={targetId} source={source} />
      <ImportRunStatus targetId={targetId} />
    </div>
  );
}
