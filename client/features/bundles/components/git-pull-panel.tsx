"use client";

import Link from "next/link";
import { useId } from "react";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import { useCan } from "@/lib/auth/can";
import { libraryRoutes } from "@/lib/routes";
import { useGitSource } from "../use-git-source";
import { GitSourceSummary } from "./git-source-summary";
import { ImportRunStatus } from "./import-run-status";
import { PullFromGitButton } from "./pull-from-git-button";

export type GitPullPanelProps = {
  targetId: string;
};

export function GitPullPanel({ targetId }: GitPullPanelProps) {
  const headingId = useId();
  const canConfigure = useCan("bundles.source_write");
  const { query, source, isPending, isError } = useGitSource(targetId);

  return (
    <section aria-labelledby={headingId} data-slot="git-pull-panel" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-lg font-semibold">
          Pull from git
        </h2>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Import the tessa folder of a repository as the next version, without zipping it. The
          clone is deleted right after the import.
        </p>
      </div>
      {isPending ? (
        <div role="status" aria-busy="true" className="flex flex-col gap-2">
          <span className="sr-only">Loading the git source</span>
          <Skeleton className="h-5 w-80 max-w-full" />
          <Skeleton className="h-8 w-32" />
        </div>
      ) : isError || source === undefined ? (
        <ErrorState
          title="Could not load the git source"
          description={describeApiError(query.error)}
          requestId={readRequestId(query.error)}
          onRetry={() => void query.refetch()}
          className="py-8"
        />
      ) : source === null ? (
        <p data-slot="git-source-missing" className="max-w-2xl text-sm text-muted-foreground">
          No git source is saved for this target.{" "}
          {canConfigure ? (
            <>
              <Link
                href={libraryRoutes.list({ target_id: targetId })}
                className="font-medium text-foreground underline underline-offset-4"
              >
                Set it up in the library
              </Link>
              .
            </>
          ) : (
            "A member or admin can set it up in the library."
          )}
        </p>
      ) : (
        <>
          <GitSourceSummary source={source} />
          <PullFromGitButton targetId={targetId} source={source} variant="outline" />
        </>
      )}
      <ImportRunStatus targetId={targetId} />
    </section>
  );
}
