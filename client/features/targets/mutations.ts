import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import type { Target, TargetCreate, TargetUpdate } from "./types";

function refreshTargetLists(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: qk.targets.lists() });
  void queryClient.invalidateQueries({ queryKey: qk.targets.options() });
}

function storeTarget(queryClient: QueryClient, target: Target): void {
  queryClient.setQueryData(qk.targets.detail(target.id), target);
}

export function useCreateTarget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: TargetCreate) => unwrap(api.POST("/api/v1/targets", { body })),
    onSuccess: (target) => {
      storeTarget(queryClient, target);
      refreshTargetLists(queryClient);
    },
  });
}

export function useUpdateTarget(targetId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: TargetUpdate) =>
      unwrap(
        api.PATCH("/api/v1/targets/{target_id}", {
          params: { path: { target_id: targetId } },
          body,
        }),
      ),
    onSuccess: (target) => {
      storeTarget(queryClient, target);
      refreshTargetLists(queryClient);
    },
  });
}

export function useRotateTargetToken(targetId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/api/v1/targets/{target_id}/token/rotate", {
          params: { path: { target_id: targetId } },
        }),
      ),
    onSuccess: (target) => storeTarget(queryClient, target),
  });
}

export function useArchiveTarget(targetId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await unwrap(
        api.DELETE("/api/v1/targets/{target_id}", { params: { path: { target_id: targetId } } }),
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.targets.detail(targetId) });
      refreshTargetLists(queryClient);
    },
  });
}
