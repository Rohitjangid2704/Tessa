"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Library, SearchX } from "lucide-react";
import Link from "next/link";
import { DataTableFooter } from "@/components/data-table";
import { EmptyState } from "@/components/states/empty-state";
import { Button } from "@/components/ui/button";
import { routes } from "@/lib/routes";
import { useUrlFilters } from "@/lib/url-state";
import { useHydrated } from "@/lib/use-hydrated";
import { libraryListQuery, toLibraryListFilters } from "../queries";
import { libraryFiltersCodec } from "../schemas";
import { LibraryFilters } from "./library-filters";
import { LibraryGitImport } from "./library-git-import";
import { LibraryTable } from "./library-table";

export function LibraryView() {
  const hydrated = useHydrated();
  const { values, setFilters, resetFilters, activeCount } = useUrlFilters(libraryFiltersCodec);
  const query = useInfiniteQuery(libraryListQuery(toLibraryListFilters(values)));

  const emptyState =
    activeCount > 0 ? (
      <EmptyState
        title="No bundles match"
        description="Change or clear the filters to see more bundles."
        icon={SearchX}
        action={
          <Button variant="outline" onClick={() => resetFilters()}>
            Clear filters
          </Button>
        }
      />
    ) : (
      <EmptyState
        title="The library is empty"
        description="Bundles appear here as soon as a target has a version. Upload a zip on a target's Bundles page, or pull one from git below."
        icon={Library}
        action={
          <Button asChild>
            <Link href={routes.targets}>Open the targets</Link>
          </Button>
        }
      />
    );

  return (
    <div data-slot="library-view" className="flex flex-col gap-10">
      <div className="flex flex-col gap-4">
        <LibraryFilters
          values={values}
          activeCount={activeCount}
          onChange={(patch) => setFilters(patch)}
          onReset={() => resetFilters()}
        />
        <LibraryTable
          rows={hydrated ? query.data?.items : undefined}
          isLoading={!hydrated || query.isPending}
          isFetching={hydrated && query.isFetching}
          error={hydrated ? query.error : null}
          onRetry={() => void query.refetch()}
          emptyState={emptyState}
          footer={
            <DataTableFooter
              noun="bundle"
              loadedCount={hydrated ? (query.data?.loadedCount ?? 0) : 0}
              total={hydrated ? query.data?.total : undefined}
              hasNextPage={hydrated && query.hasNextPage}
              isFetchingNextPage={query.isFetchingNextPage}
              onLoadMore={() => void query.fetchNextPage()}
            />
          }
        />
      </div>
      <LibraryGitImport filteredTargetId={values.target_id} />
    </div>
  );
}
