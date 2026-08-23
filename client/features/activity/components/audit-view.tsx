"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ScrollText, SearchX } from "lucide-react";
import { DataTableFooter } from "@/components/data-table";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import { useUrlFilters } from "@/lib/url-state";
import { useHydrated } from "@/lib/use-hydrated";
import { auditActorsQuery, auditEventsQuery } from "../queries";
import { auditFiltersCodec, toAuditListFilters } from "../schemas";
import { AuditFilters } from "./audit-filters";
import { AuditTable } from "./audit-table";

function AuditSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-3">
      <span className="sr-only">Loading the audit log</span>
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export function AuditView() {
  const hydrated = useHydrated();
  const { values, setFilters, resetFilters, activeCount } = useUrlFilters(auditFiltersCodec);
  const query = useInfiniteQuery(auditEventsQuery(toAuditListFilters(values)));
  const actors = useQuery(auditActorsQuery());
  const actorNames = new Map((actors.data ?? []).map((user) => [user.id, user.name]));

  const rows = query.data?.items ?? [];
  const total = query.data?.total ?? null;

  function renderBody() {
    if (!hydrated || query.isPending) {
      return <AuditSkeleton />;
    }
    if (query.isError && rows.length === 0) {
      return (
        <ErrorState
          title="Could not load the audit log"
          description={describeApiError(query.error)}
          requestId={readRequestId(query.error)}
          onRetry={() => void query.refetch()}
        />
      );
    }
    if (rows.length === 0) {
      return activeCount > 0 ? (
        <EmptyState
          title="No events match"
          description="Change or clear the filters to see more of the audit log."
          icon={SearchX}
          action={
            <Button variant="outline" onClick={() => resetFilters()}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <EmptyState
          title="The audit log is empty"
          description="Administration changes and every write made with a personal token are recorded here."
          icon={ScrollText}
        />
      );
    }
    return (
      <>
        <AuditTable
          rows={rows}
          actorNames={actorNames}
          total={total}
          hasNextPage={query.hasNextPage}
          isFetchingNextPage={query.isFetchingNextPage}
          onLoadMore={() => void query.fetchNextPage()}
        />
        <DataTableFooter
          noun="event"
          loadedCount={rows.length}
          total={total}
          hasNextPage={query.hasNextPage}
          isFetchingNextPage={query.isFetchingNextPage}
          onLoadMore={() => void query.fetchNextPage()}
        />
      </>
    );
  }

  return (
    <div data-slot="audit-view" className="flex flex-col gap-4">
      <AuditFilters
        values={values}
        activeCount={activeCount}
        actors={actors.data ?? []}
        onChange={(patch) => setFilters(patch)}
        onReset={() => resetFilters()}
      />
      <div aria-busy={query.isFetching} className="flex flex-col gap-3">
        {renderBody()}
      </div>
    </div>
  );
}
