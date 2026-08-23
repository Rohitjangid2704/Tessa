"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { MessageSquareText } from "lucide-react";
import { DateTime } from "@/components/date-time";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TruncatedText } from "@/features/steps/components/text-view";
import { describeApiError } from "@/lib/api/errors";
import type { Explanation, Finding } from "@/lib/api/types";
import { findingExplanationsOptions } from "../detail-queries";
import { extractCodeReferences, parseStructuredExplanation, shortId } from "../detail-schemas";
import { ExplainPromptDialog } from "./explain-prompt-dialog";
import { StructuredExplanationCard } from "./structured-explanation-card";

export const EXPLANATION_PREVIEW_CHARACTERS = 4000;

export interface ExplanationListProps {
  finding: Pick<Finding, "id" | "target_id">;
}

function CodeReferenceChips({ text }: { text: string }) {
  const references = extractCodeReferences(text);
  if (references.length === 0) {
    return null;
  }
  return (
    <ul aria-label="Code references" className="flex flex-wrap gap-1.5">
      {references.map((reference) => (
        <li key={reference.label}>
          <Badge
            variant="outline"
            className="h-auto max-w-full font-mono wrap-anywhere whitespace-normal"
          >
            {reference.label}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function ExplanationItem({ explanation }: { explanation: Explanation }) {
  const structured = parseStructuredExplanation(explanation.structured);
  return (
    <li
      data-slot="explanation-item"
      className="flex flex-col gap-2 rounded-lg border bg-card px-3 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <Badge variant="secondary">Claude Code</Badge>
        <DateTime value={explanation.created_at} />
        <span>by {shortId(explanation.created_by)}</span>
      </div>
      {structured === null ? null : <StructuredExplanationCard structured={structured} />}
      <p className="text-sm">
        <TruncatedText text={explanation.text} limit={EXPLANATION_PREVIEW_CHARACTERS} />
      </p>
      <CodeReferenceChips text={explanation.text} />
    </li>
  );
}

export function ExplanationList({ finding }: ExplanationListProps) {
  const query = useInfiniteQuery(findingExplanationsOptions(finding.id));

  if (query.isPending) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-3">
        <span className="sr-only">Loading explanations</span>
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <ErrorState
        title="Could not load the explanations"
        description={describeApiError(query.error)}
        requestId={readRequestId(query.error)}
        onRetry={() => void query.refetch()}
        className="py-8"
      />
    );
  }
  if (query.data.items.length === 0) {
    return (
      <EmptyState
        title="Paste Claude Code's answer here"
        description="Copy the Explain prompt, run it in Claude Code on the repository, then paste the answer in the box above. It is kept with the finding."
        icon={MessageSquareText}
        className="py-8"
        action={<ExplainPromptDialog finding={finding} />}
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ul
        data-slot="explanation-list"
        aria-label="Explanations, newest first"
        className="flex flex-col gap-3"
      >
        {query.data.items.map((explanation) => (
          <ExplanationItem key={explanation.id} explanation={explanation} />
        ))}
      </ul>
      {query.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? "Loading" : "Load more explanations"}
        </Button>
      ) : null}
    </div>
  );
}
