"use client";

import { useQuery } from "@tanstack/react-query";
import { LibraryBig, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/states/empty-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { bundleDetailQuery } from "@/features/bundles/queries";
import { latestBundleQuery } from "@/features/targets/queries";
import { targetRoutes } from "@/lib/routes";

export interface NoBundleStateProps {
  targetId: string;
  bundleId: string | null;
}

function InvalidBundleAlert({
  targetId,
  bundleId,
  version,
}: {
  targetId: string;
  bundleId: string;
  version: number;
}) {
  return (
    <Alert variant="destructive" data-slot="invalid-bundle-alert">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>Version {version} did not validate</AlertTitle>
      <AlertDescription>
        <p>
          An invalid bundle has no catalog.{" "}
          <Link
            href={targetRoutes.bundle(targetId, bundleId)}
            className="underline underline-offset-3"
          >
            See the validation errors for version {version}
          </Link>{" "}
          and upload a fixed version.
        </p>
      </AlertDescription>
    </Alert>
  );
}

function LatestBundleHint({ targetId }: { targetId: string }) {
  const latest = useQuery(latestBundleQuery(targetId));
  const bundle = latest.data;
  if (bundle === null || bundle === undefined || bundle.validation_status !== "invalid") {
    return null;
  }
  return <InvalidBundleAlert targetId={targetId} bundleId={bundle.id} version={bundle.version} />;
}

function RequestedBundleHint({ targetId, bundleId }: { targetId: string; bundleId: string }) {
  const requested = useQuery(bundleDetailQuery(bundleId));
  const bundle = requested.data;
  if (bundle === undefined) {
    return null;
  }
  if (bundle.validation_status === "invalid") {
    return <InvalidBundleAlert targetId={targetId} bundleId={bundle.id} version={bundle.version} />;
  }
  return (
    <p role="status" className="text-center text-sm text-muted-foreground">
      Version {bundle.version} is valid but declares no features.
    </p>
  );
}

export function NoBundleState({ targetId, bundleId }: NoBundleStateProps) {
  return (
    <div data-slot="no-bundle-state" className="flex flex-col gap-4">
      {bundleId === null ? (
        <LatestBundleHint targetId={targetId} />
      ) : (
        <RequestedBundleHint targetId={targetId} bundleId={bundleId} />
      )}
      <EmptyState
        title={bundleId === null ? "No valid bundle yet" : "This bundle has no catalog"}
        description="The catalog is built from a validated bundle. Upload the zip Claude Code produced from the Discovery prompt and its features appear here."
        icon={LibraryBig}
        action={
          <Button asChild>
            <Link href={targetRoutes.bundles(targetId)}>Upload a bundle</Link>
          </Button>
        }
      />
    </div>
  );
}
