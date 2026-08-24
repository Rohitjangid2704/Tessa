"use client";

import { useQuery } from "@tanstack/react-query";
import { Check, Package, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import { DateTime } from "@/components/date-time";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { StatusBadge } from "@/components/status/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError } from "@/lib/api/errors";
import { targetRoutes } from "@/lib/routes";
import { latestBundleQuery } from "../queries";

export function LatestBundleCard({ targetId }: { targetId: string }) {
  const query = useQuery(latestBundleQuery(targetId));

  return (
    <Card data-slot="latest-bundle-card">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Latest bundle
        </CardTitle>
        <CardDescription>The newest version uploaded for this target.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {query.isPending ? (
          <div role="status" aria-busy="true" className="flex flex-col gap-2">
            <span className="sr-only">Loading the latest bundle</span>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-56" />
          </div>
        ) : query.isError ? (
          <ErrorState
            title="Could not load the latest bundle"
            description={describeApiError(query.error)}
            requestId={readRequestId(query.error)}
            onRetry={() => void query.refetch()}
            className="py-6"
          />
        ) : query.data === null ? (
          <div className="flex flex-col gap-3">
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Package aria-hidden="true" className="size-4" />
              No bundle yet. Paste the Discovery prompt into Claude Code, then upload the zip.
            </p>
            <div>
              <Button asChild size="sm">
                <Link href={targetRoutes.bundles(targetId)}>Upload a bundle</Link>
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-lg font-semibold tabular-nums">
                Version {query.data.version}
              </span>
              {query.data.validation_status === "valid" ? (
                <StatusBadge tone="verdict-pass" label="Valid" icon={Check} />
              ) : (
                <StatusBadge tone="verdict-fail" label="Invalid" icon={X} />
              )}
              {query.data.completeness_status === "meets_bar" ? (
                <StatusBadge tone="verdict-pass" label="Meets bar" icon={Check} />
              ) : (
                <StatusBadge tone="verdict-flaky" label="Below bar" icon={TriangleAlert} />
              )}
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Completeness</dt>
              <dd className="tabular-nums">{query.data.completeness_score} / 100</dd>
              <dt className="text-muted-foreground">Features</dt>
              <dd className="tabular-nums">{query.data.feature_count}</dd>
              <dt className="text-muted-foreground">Uploaded</dt>
              <dd>
                <DateTime value={query.data.uploaded_at} />
              </dd>
            </dl>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <Link href={targetRoutes.bundle(targetId, query.data.id)}>Open bundle</Link>
              </Button>
              <Button asChild variant="ghost" size="sm">
                <Link href={targetRoutes.bundles(targetId)}>All versions</Link>
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
