"use client";

import { GitBranch, GitCommitHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { Bundle } from "@/lib/api/types";

export const COMMIT_SHA_DISPLAY_LENGTH = 7;
export const NO_SOURCE_RECORDED = "No source recorded";

export type BundleSourceChipsProps = {
  bundle: Pick<Bundle, "commit_sha" | "branch">;
};

export function BundleSourceChips({ bundle }: BundleSourceChipsProps) {
  const commitSha = bundle.commit_sha ?? null;
  const branch = bundle.branch ?? null;

  if (commitSha === null && branch === null) {
    return (
      <p data-slot="bundle-source-chips" className="text-sm text-muted-foreground">
        {NO_SOURCE_RECORDED}
      </p>
    );
  }

  return (
    <TooltipProvider>
      <ul
        data-slot="bundle-source-chips"
        aria-label="Source commit and branch"
        className="flex flex-wrap items-center gap-2"
      >
        {commitSha === null ? null : (
          <li>
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  tabIndex={0}
                  data-slot="commit-chip"
                  aria-label={`Commit ${commitSha}`}
                  className="font-mono"
                >
                  <GitCommitHorizontal aria-hidden="true" />
                  {commitSha.slice(0, COMMIT_SHA_DISPLAY_LENGTH)}
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="font-mono">{commitSha}</TooltipContent>
            </Tooltip>
          </li>
        )}
        {branch === null ? null : (
          <li>
            <Badge variant="outline" data-slot="branch-chip" className="font-mono">
              <GitBranch aria-hidden="true" />
              {branch}
            </Badge>
          </li>
        )}
      </ul>
    </TooltipProvider>
  );
}
