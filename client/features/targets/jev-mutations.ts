import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";

export function useSetAllowJev(targetId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: (allowJev: boolean) =>
      unwrap(
        api.PATCH("/api/v1/targets/{target_id}", {
          params: { path: { target_id: targetId } },
          body: { allow_jev: allowJev },
        }),
      ),
    onSuccess: (target) => {
      queryClient.setQueryData(qk.targets.detail(target.id), target);
      void queryClient.invalidateQueries({ queryKey: qk.targets.lists() });
      void queryClient.invalidateQueries({ queryKey: qk.targets.options() });
    },
  });
}
