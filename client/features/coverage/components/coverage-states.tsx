"use client";

import { Grid3x3, PackageOpen } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { describeApiError, isApiError } from "@/lib/api/errors";
import { targetRoutes } from "@/lib/routes";

export function isBundleMissing(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.status === 409 &&
    error.details.some((detail) => detail.code === "bundle_missing" || detail.loc[0] === "bundle")
  );
}

export function CoverageError({
  error,
  targetId,
  onRetry,
}: {
  error: unknown;
  targetId: string;
  onRetry: () => void;
}) {
  if (isBundleMissing(error)) {
    return <NoBundle targetId={targetId} />;
  }
  return (
    <ErrorState
      title="Could not load the coverage map"
      description={describeApiError(error)}
      requestId={readRequestId(error)}
      onRetry={onRetry}
    />
  );
}

export function NoBundle({ targetId }: { targetId: string }) {
  return (
    <EmptyState
      icon={PackageOpen}
      title="This target has no valid bundle yet"
      description="Coverage is drawn from the features of a bundle. Upload one and the map appears here."
      action={
        <Button asChild>
          <Link href={targetRoutes.bundles(targetId)}>Upload a bundle</Link>
        </Button>
      }
    />
  );
}

export function NoFeatures({ targetId }: { targetId: string }) {
  return (
    <EmptyState
      icon={Grid3x3}
      title="Nothing to cover yet"
      description="The latest bundle of this target lists no feature that runs as a role on an interface. Add features to the bundle and upload it again."
      action={
        <Button asChild variant="outline">
          <Link href={targetRoutes.bundles(targetId)}>Open the bundles</Link>
        </Button>
      }
    />
  );
}

export function NoMatches({ onClear }: { onClear: () => void }) {
  return (
    <EmptyState
      icon={Grid3x3}
      title="No cell matches these filters"
      description="Clear the status or area filter to see the whole map again."
      action={
        <Button type="button" variant="outline" onClick={onClear}>
          Clear filters
        </Button>
      }
    />
  );
}
