import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { bundleDetailQuery, bundleVersionsOptions } from "@/features/bundles/queries";
import type { components } from "@/lib/api/schema";

export type BundleSummary = components["schemas"]["BundleSummary"];

export interface SideSelection {
  targetId: string | null;
  bundleId: string | null;
}

export const EMPTY_SIDE_SELECTION: SideSelection = { targetId: null, bundleId: null };

const NO_BUNDLES: readonly BundleSummary[] = [];

export interface SideChoice {
  targetId: string | null;
  bundleId: string | null;
  bundles: readonly BundleSummary[];
  selected: BundleSummary | null;
  isLoadingBundles: boolean;
  bundlesError: unknown;
  retryBundles: () => void;
  linkedBundleMissing: boolean;
}

export function useSideChoice(
  selection: SideSelection,
  linkedBundleId: string | undefined,
): SideChoice {
  const linkedApplies = selection.targetId === null && linkedBundleId !== undefined;
  const linked = useQuery({
    ...bundleDetailQuery(linkedBundleId ?? ""),
    enabled: linkedApplies,
  });
  const targetId = selection.targetId ?? (linkedApplies ? (linked.data?.target_id ?? null) : null);
  const versions = useInfiniteQuery({
    ...bundleVersionsOptions(targetId ?? ""),
    enabled: targetId !== null,
  });
  const bundles = versions.data?.items ?? NO_BUNDLES;
  const latestValid = bundles.find((bundle) => bundle.validation_status === "valid") ?? null;
  const linkedChoice =
    linkedApplies && linked.data !== undefined && linked.data.target_id === targetId
      ? linked.data.id
      : null;
  const bundleId = selection.bundleId ?? linkedChoice ?? latestValid?.id ?? null;
  const selected = bundles.find((bundle) => bundle.id === bundleId) ?? null;
  const refetchVersions = versions.refetch;

  return {
    targetId,
    bundleId,
    bundles,
    selected,
    isLoadingBundles:
      (targetId !== null && versions.isPending) || (linkedApplies && linked.isPending),
    bundlesError: versions.error,
    retryBundles: () => void refetchVersions(),
    linkedBundleMissing: linkedApplies && linked.isError,
  };
}
