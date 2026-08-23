"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronRight, History } from "lucide-react";
import Link from "next/link";
import { DateTime } from "@/components/date-time";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { JsonView } from "@/features/steps/components/json-view";
import { describeApiError } from "@/lib/api/errors";
import type { FindingOccurrence } from "@/lib/api/types";
import { findingRoutes, runRoutes } from "@/lib/routes";
import { findingOccurrencesOptions } from "../detail-queries";
import { readPossibleDuplicate, shortId } from "../detail-schemas";

export interface OccurrenceListProps {
  findingId: string;
}

function describeAttempt(attempt: number | null): string {
  return attempt === null ? "Run level" : `Attempt ${attempt + 1}`;
}

function OccurrenceItem({ occurrence }: { occurrence: FindingOccurrence }) {
  const duplicateOf = readPossibleDuplicate(occurrence.evidence);
  return (
    <li
      data-slot="occurrence-item"
      className="flex flex-col gap-2 rounded-lg border bg-card px-3 py-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <DateTime value={occurrence.seen_at} className="font-medium" />
        <Link
          href={runRoutes.detail(occurrence.run_id)}
          className="text-primary underline underline-offset-4"
        >
          Run {shortId(occurrence.run_id)}
        </Link>
        <span className="text-muted-foreground">{describeAttempt(occurrence.attempt)}</span>
        {occurrence.step_id === null ? null : (
          <Link
            href={runRoutes.step(occurrence.run_id, occurrence.step_id)}
            className="text-primary underline underline-offset-4"
          >
            Open step {shortId(occurrence.step_id)}
          </Link>
        )}
      </div>
      {duplicateOf === null ? null : (
        <p data-slot="possible-duplicate" className="text-xs text-muted-foreground">
          Possible duplicate of{" "}
          <Link
            href={findingRoutes.detail(duplicateOf)}
            className="font-medium text-primary underline underline-offset-4"
          >
            finding {shortId(duplicateOf)}
          </Link>
          . The matcher was not sure, so this was kept as its own finding.
        </p>
      )}
      <Collapsible className="flex flex-col gap-2">
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="xs" className="group self-start">
            <ChevronRight
              aria-hidden="true"
              className="transition-transform group-aria-expanded:rotate-90 motion-reduce:transition-none"
              data-icon="inline-start"
            />
            Evidence
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <JsonView value={occurrence.evidence} label="Occurrence evidence" defaultOpenDepth={1} />
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

export function OccurrenceList({ findingId }: OccurrenceListProps) {
  const query = useInfiniteQuery(findingOccurrencesOptions(findingId));

  if (query.isPending) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-3">
        <span className="sr-only">Loading occurrences</span>
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <ErrorState
        title="Could not load the occurrences"
        description={describeApiError(query.error)}
        requestId={readRequestId(query.error)}
        onRetry={() => void query.refetch()}
        className="py-8"
      />
    );
  }
  const { items, total, loadedCount } = query.data;
  if (items.length === 0) {
    return (
      <EmptyState
        title="No occurrences yet"
        description="Each time a run hits this failure it is listed here."
        icon={History}
        className="py-8"
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p role="status" className="text-xs text-muted-foreground">
        {total === null ? `${loadedCount} loaded` : `${loadedCount} of ${total} shown`}, newest first
      </p>
      <ul data-slot="occurrence-list" aria-label="Occurrences, newest first" className="flex flex-col gap-3">
        {items.map((occurrence) => (
          <OccurrenceItem key={occurrence.id} occurrence={occurrence} />
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
          {query.isFetchingNextPage ? "Loading" : "Load more occurrences"}
        </Button>
      ) : null}
    </div>
  );
}
