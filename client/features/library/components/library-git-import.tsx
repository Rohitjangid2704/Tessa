"use client";

import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { GitSourcePanel } from "@/features/bundles/components/git-source-panel";
import { TargetSelect } from "@/features/targets/components/target-select";
import { useCurrentTargetId } from "@/features/targets/current-target";
import { targetOptionsQuery } from "@/features/targets/queries";
import { useHydrated } from "@/lib/use-hydrated";

export type LibraryGitImportProps = {
  filteredTargetId: string | undefined;
};

function hasTarget(targets: readonly { id: string }[], targetId: string | null | undefined) {
  return targetId !== null && targetId !== undefined && targets.some(({ id }) => id === targetId);
}

export function LibraryGitImport({ filteredTargetId }: LibraryGitImportProps) {
  const headingId = useId();
  const hydrated = useHydrated();
  const options = useQuery(targetOptionsQuery());
  const currentTargetId = useCurrentTargetId();
  const [pickedTargetId, setPickedTargetId] = useState<string | null>(null);
  const loading = !hydrated || options.isPending;
  const targets = loading ? [] : (options.data ?? []);
  const preferred = [pickedTargetId, filteredTargetId, currentTargetId].find((candidate) =>
    hasTarget(targets, candidate),
  );
  const targetId = preferred ?? targets[0]?.id ?? null;

  return (
    <section
      aria-labelledby={headingId}
      data-slot="library-git-import"
      className="flex flex-col gap-4 border-t pt-8"
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-lg font-semibold">
          Import from git
        </h2>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Each target can name one repository. Tessa pulls its tessa folder as the next
          bundle version, validates it like an upload and never keeps the clone.
        </p>
      </div>
      {loading ? (
        <div role="status" aria-busy="true" className="flex flex-col gap-3">
          <span className="sr-only">Loading the targets</span>
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-9 w-full max-w-2xl" />
        </div>
      ) : targetId === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          {options.isError
            ? "The targets could not be loaded, so there is nothing to configure."
            : "Create a target first. A git source belongs to one target."}
        </p>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium">Target</span>
            <TargetSelect
              value={targetId}
              onChange={setPickedTargetId}
              options={targets.map((target) => ({
                id: target.id,
                name: target.name,
                tier: target.tier,
                archived: target.archived_at != null,
              }))}
              label="Target for the git source"
            />
          </div>
          <GitSourcePanel key={targetId} targetId={targetId} />
        </>
      )}
    </section>
  );
}
