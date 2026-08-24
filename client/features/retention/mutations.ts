import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import type { RetentionPolicy, RetentionState } from "@/lib/api/types";
import { unwrap } from "@/lib/api/unwrap";

export function usePutRetention() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: (policy: RetentionPolicy) =>
      unwrap(api.PUT("/api/v1/settings/retention", { body: policy })),
    onSuccess: (policy) => {
      queryClient.setQueryData<RetentionState>(qk.retention(), (current) =>
        current === undefined ? current : { ...current, policy },
      );
      return queryClient.invalidateQueries({ queryKey: qk.retention() });
    },
  });
}
