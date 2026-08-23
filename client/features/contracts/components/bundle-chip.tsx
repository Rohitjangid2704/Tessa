"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { CompletenessBadge } from "@/features/bundles/components/bundle-badges";
import { bundleDetailQuery } from "@/features/bundles/queries";
import { targetQuery } from "@/features/targets/queries";
import { targetRoutes } from "@/lib/routes";

export type BundleChipProps = {
  bundleId: string;
  showCompleteness?: boolean;
};

const SHORT_ID_LENGTH = 8;

export function BundleChip({ bundleId, showCompleteness = false }: BundleChipProps) {
  const bundle = useQuery(bundleDetailQuery(bundleId));
  const targetId = bundle.data?.target_id ?? null;
  const target = useQuery({ ...targetQuery(targetId ?? ""), enabled: targetId !== null });

  if (bundle.isError) {
    return (
      <span data-slot="bundle-chip" data-state="unavailable" className="text-muted-foreground">
        Bundle {bundleId.slice(0, SHORT_ID_LENGTH)} unavailable
      </span>
    );
  }
  if (bundle.data === undefined) {
    return <Skeleton data-slot="bundle-chip" data-state="loading" className="h-4 w-28" />;
  }
  const name = target.data?.name ?? `Target ${bundle.data.target_id.slice(0, SHORT_ID_LENGTH)}`;

  return (
    <span data-slot="bundle-chip" className="inline-flex flex-wrap items-center gap-2">
      <Link
        href={targetRoutes.bundle(bundle.data.target_id, bundle.data.id)}
        className="font-medium underline-offset-4 hover:underline"
      >
        {name} version {bundle.data.version}
      </Link>
      {showCompleteness ? <CompletenessBadge status={bundle.data.completeness.status} /> : null}
    </span>
  );
}
