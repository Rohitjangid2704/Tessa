"use client";

import { LoaderCircle, TriangleAlert } from "lucide-react";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { pluralize } from "@/features/bundles/format";
import { ClaudeCodeCommand } from "@/features/claude-code/components/claude-code-command";
import { describeApiError } from "@/lib/api/errors";

export interface ProposalFooterProps {
  selectedIds: readonly string[];
  canPlan: boolean;
  planning: boolean;
  planError: unknown;
  onPlan: () => void;
}

export function ProposalFooter({
  selectedIds,
  canPlan,
  planning,
  planError,
  onPlan,
}: ProposalFooterProps) {
  const count = selectedIds.length;
  const requestId = readRequestId(planError);

  return (
    <section
      aria-label="Selected proposal items"
      data-slot="proposal-footer"
      className="sticky bottom-0 z-10 -mx-4 mt-2 flex flex-col gap-3 border-t bg-background px-4 py-3 md:-mx-6 md:px-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <p className="text-sm font-medium tabular-nums" data-slot="selected-item-count">
          {pluralize(count, "item")} selected
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {count === 0 ? null : (
            <ClaudeCodeCommand template="author" params={{ item_ids: selectedIds }} />
          )}
          {canPlan ? (
            <Button type="button" disabled={count === 0 || planning} onClick={onPlan}>
              {planning ? (
                <LoaderCircle
                  aria-hidden="true"
                  data-icon="inline-start"
                  className="animate-spin"
                />
              ) : null}
              {planning ? "Planning" : "Plan from selection"}
            </Button>
          ) : null}
        </div>
      </div>
      {count === 0 ? (
        <p className="text-xs text-muted-foreground">
          {canPlan
            ? "Nothing is selected yet. Tick items to plan them here or to author them in Claude Code."
            : "Nothing is selected yet. A member of the team ticks the items to plan or author."}
        </p>
      ) : null}
      {planError === null || planError === undefined ? null : (
        <Alert variant="destructive" role="alert" data-slot="proposal-plan-error">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription>
            <p>Could not save the plan. {describeApiError(planError)}</p>
            {requestId === null ? null : (
              <p className="font-mono text-xs">Request ID: {requestId}</p>
            )}
          </AlertDescription>
        </Alert>
      )}
    </section>
  );
}
