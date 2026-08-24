import { useQuery } from "@tanstack/react-query";
import { bundleDetailQuery } from "@/features/bundles/queries";
import { latestBundleQuery } from "@/features/targets/queries";

export function useLatestBundle(targetId: string) {
  const latest = useQuery(latestBundleQuery(targetId));
  const bundleId = latest.data?.id;
  const detail = useQuery({
    ...bundleDetailQuery(bundleId ?? ""),
    enabled: bundleId !== undefined,
  });
  const error = latest.error ?? detail.error;
  return {
    bundle: detail.data ?? null,
    hasBundle: latest.isSuccess && bundleId !== undefined,
    isPending: latest.isPending || (bundleId !== undefined && detail.isPending),
    error,
    refetch: () => {
      void latest.refetch();
      void detail.refetch();
    },
  };
}
