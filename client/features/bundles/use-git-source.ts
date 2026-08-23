import { useQuery } from "@tanstack/react-query";
import { useHydrated } from "@/lib/use-hydrated";
import { bundleSourceQuery } from "./bundle-source-queries";

export function useGitSource(targetId: string) {
  const hydrated = useHydrated();
  const query = useQuery(bundleSourceQuery(targetId));
  return {
    query,
    source: hydrated ? query.data : undefined,
    isPending: !hydrated || query.isPending,
    isError: hydrated && query.isError,
  };
}
