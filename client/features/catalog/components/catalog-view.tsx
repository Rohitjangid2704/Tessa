"use client";

import { useQuery } from "@tanstack/react-query";
import { LibraryBig, SearchX } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { z } from "zod";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CurrentTargetGate } from "@/features/targets/current-target-gate";
import { pluralize } from "@/features/bundles/format";
import { describeApiError, isApiError } from "@/lib/api/errors";
import { targetRoutes } from "@/lib/routes";
import { useUrlFilters } from "@/lib/url-state";
import { useHydrated } from "@/lib/use-hydrated";
import {
  areaTotals,
  BUNDLE_ID_PARAM,
  catalogQuery,
  hasNoCatalogContent,
  interfaceKindMap,
  itemCount,
  keepCatalogWithinScope,
  LARGE_CATALOG_FEATURES,
} from "../queries";
import { catalogFiltersCodec } from "../schemas";
import type { CatalogSelection } from "../selection";
import { AreaTree } from "./area-tree";
import { CatalogFilters } from "./catalog-filters";
import { CatalogSummary } from "./catalog-summary";
import { NoBundleState } from "./no-bundle-state";

const NO_SEARCH_PARAMS = new URLSearchParams();
const bundleIdSchema = z.guid();

function readBundleId(searchParams: { get: (name: string) => string | null }): string | null {
  const raw = searchParams.get(BUNDLE_ID_PARAM);
  const parsed = bundleIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function CatalogSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4">
      <span className="sr-only">Loading the catalog</span>
      <Skeleton className="h-5 w-64" />
      <Skeleton className="h-8 w-full max-w-3xl" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

export interface CatalogExplorerProps {
  targetId: string;
  selection?: CatalogSelection;
}

export function CatalogExplorer({ targetId, selection }: CatalogExplorerProps) {
  const hydrated = useHydrated();
  const searchParams = useSearchParams() ?? NO_SEARCH_PARAMS;
  const bundleId = readBundleId(searchParams);
  const { values, setFilters, resetFilters, activeCount } = useUrlFilters(catalogFiltersCodec);
  const request = { targetId, bundleId, filters: values };
  const filtered = useQuery({
    ...catalogQuery(request),
    placeholderData: keepCatalogWithinScope(request),
  });
  const unfiltered = useQuery({
    ...catalogQuery({ targetId, bundleId, filters: {} }),
    enabled: activeCount > 0,
  });

  if (!hydrated || filtered.isPending) {
    return <CatalogSkeleton />;
  }

  if (filtered.isError) {
    const notFound = isApiError(filtered.error) && filtered.error.status === 404;
    return (
      <ErrorState
        title={notFound ? "Target or bundle not found" : "Could not load the catalog"}
        description={
          notFound
            ? "This target or bundle does not exist. Pick another target from the targets list."
            : describeApiError(filtered.error)
        }
        requestId={readRequestId(filtered.error)}
        onRetry={notFound ? undefined : () => void filtered.refetch()}
        action={
          notFound ? (
            <Button asChild variant="outline">
              <Link href={targetRoutes.list()}>Back to targets</Link>
            </Button>
          ) : undefined
        }
      />
    );
  }

  const catalog = filtered.data;
  if (catalog.bundle_id === null || (activeCount === 0 && hasNoCatalogContent(catalog))) {
    return <NoBundleState targetId={targetId} bundleId={catalog.bundle_id} />;
  }

  const baseline = activeCount > 0 ? unfiltered.data : catalog;
  const totalFeatures = itemCount(baseline);
  const shownFeatures = itemCount(catalog);
  const totals = areaTotals(baseline);
  const collapseAreas = shownFeatures > LARGE_CATALOG_FEATURES;
  const areaNames = (baseline?.areas ?? []).map((area) => area.name);
  const countLine =
    activeCount > 0 && baseline !== undefined
      ? `Showing ${shownFeatures} of ${pluralize(totalFeatures, "feature")} in ${pluralize(catalog.areas.length, "area")}`
      : `${pluralize(shownFeatures, "feature")} in ${pluralize(catalog.areas.length, "area")}`;

  return (
    <div
      data-slot="catalog-view"
      aria-busy={filtered.isPlaceholderData}
      className="flex flex-col gap-6"
    >
      <CatalogSummary
        targetId={targetId}
        bundleId={catalog.bundle_id}
        bundleVersion={catalog.bundle_version ?? 0}
        featureCount={baseline === undefined ? shownFeatures : totalFeatures}
        areaCount={baseline === undefined ? catalog.areas.length : baseline.areas.length}
        roles={catalog.roles}
        interfaces={catalog.interfaces}
      />
      <CatalogFilters
        values={values}
        onChange={(patch) => setFilters(patch)}
        onReset={() => resetFilters()}
        activeCount={activeCount}
        areas={areaNames}
        roles={catalog.roles}
        interfaces={catalog.interfaces}
      />
      <p role="status" className="text-sm text-muted-foreground tabular-nums">
        {countLine}
      </p>
      {collapseAreas ? (
        <p data-slot="large-catalog-note" className="text-sm text-muted-foreground">
          This catalog is large, so the areas start collapsed. Open one to see its features, or
          narrow the list with the filters.
        </p>
      ) : null}
      {shownFeatures === 0 ? (
        <EmptyState
          title={activeCount > 0 ? "No features match" : "No features in this bundle"}
          description={
            activeCount > 0
              ? "Change or clear the filters to see more features."
              : "The manifest of this bundle declares no features."
          }
          icon={activeCount > 0 ? SearchX : LibraryBig}
          action={
            activeCount > 0 ? (
              <Button variant="outline" onClick={() => resetFilters()}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <AreaTree
          key={collapseAreas ? "collapsed" : "open"}
          areas={catalog.areas}
          totals={totals}
          selection={selection}
          interfaceKinds={interfaceKindMap(catalog.interfaces)}
          defaultOpen={!collapseAreas}
        />
      )}
    </div>
  );
}

export interface CatalogViewProps {
  selection?: CatalogSelection;
}

export function CatalogView({ selection }: CatalogViewProps) {
  return (
    <CurrentTargetGate
      title="Choose a target"
      description="The catalog lists the features found in one target's latest valid bundle. Pick a target to browse it."
    >
      {(targetId) => <CatalogExplorer targetId={targetId} selection={selection} />}
    </CurrentTargetGate>
  );
}
