import { useMutation, useQueryClient } from "@tanstack/react-query";
import { catalogQuery } from "@/features/catalog/queries";
import { api } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import { planQuery } from "./queries";
import type { Plan, PlanCreate, PlanUpdate, RunCreate, RunHandle } from "./types";
import { useFingerprintedKey } from "./use-fingerprinted-key";

type PlanDraft = Omit<PlanCreate, "saved">;

export interface RunNowInput {
  plan: PlanDraft;
  resetSeed: boolean;
}

export interface RunNowOptions {
  onSuccess?: (handle: RunHandle) => void;
}

export interface SavePlanOptions {
  onSuccess?: (plan: Plan) => void;
}

interface KeyedBody<Body> {
  body: Body;
  idempotencyKey: string;
}

export function useRunNow() {
  const queryClient = useQueryClient();
  const idempotency = useFingerprintedKey();
  const mutation = useMutation({
    mutationFn: ({ body, idempotencyKey }: KeyedBody<RunCreate>) =>
      unwrap(
        api.POST("/api/v1/runs", {
          params: { header: { "Idempotency-Key": idempotencyKey } },
          body,
        }),
      ),
    onSuccess: () => {
      idempotency.forget();
      void queryClient.invalidateQueries({ queryKey: qk.runs.lists() });
      void queryClient.invalidateQueries({ queryKey: qk.plans.lists() });
    },
    onError: (error) => {
      if (isApiError(error) && error.isClientError) {
        idempotency.forget();
      }
    },
  });

  function run(input: RunNowInput, options: RunNowOptions = {}): void {
    const body: RunCreate = {
      plan: { ...input.plan, saved: false },
      reset_seed: input.resetSeed,
    };
    mutation.mutate(
      { body, idempotencyKey: idempotency.keyFor(body) },
      { onSuccess: options.onSuccess },
    );
  }

  return { run, isPending: mutation.isPending, error: mutation.error, reset: mutation.reset };
}

export function useSavePlan() {
  const queryClient = useQueryClient();
  const idempotency = useFingerprintedKey();
  const mutation = useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ body, idempotencyKey }: KeyedBody<PlanCreate>) =>
      unwrap(
        api.POST("/api/v1/plans", {
          params: { header: { "Idempotency-Key": idempotencyKey } },
          body,
        }),
      ),
    onSuccess: (plan) => {
      idempotency.forget();
      queryClient.setQueryData(qk.plans.detail(plan.id), plan);
      void queryClient.invalidateQueries({ queryKey: qk.plans.lists() });
    },
    onError: (error) => {
      if (isApiError(error) && error.isClientError) {
        idempotency.forget();
      }
    },
  });

  function save(input: PlanDraft, options: SavePlanOptions = {}): void {
    const body: PlanCreate = { ...input, saved: true };
    mutation.mutate(
      { body, idempotencyKey: idempotency.keyFor(body) },
      { onSuccess: options.onSuccess },
    );
  }

  return { save, isPending: mutation.isPending, error: mutation.error, reset: mutation.reset };
}

export interface UpdatePlanVariables {
  planId: string;
  update: PlanUpdate;
}

export function useUpdatePlan() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ planId, update }: UpdatePlanVariables) =>
      unwrap(
        api.PATCH("/api/v1/plans/{plan_id}", {
          params: { path: { plan_id: planId } },
          body: update,
        }),
      ),
    onSuccess: (plan) => {
      queryClient.setQueryData(qk.plans.detail(plan.id), plan);
      void queryClient.invalidateQueries({ queryKey: qk.plans.lists() });
    },
  });
}

export function useDeletePlan() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: async (planId: string) => {
      await unwrap(
        api.DELETE("/api/v1/plans/{plan_id}", { params: { path: { plan_id: planId } } }),
      );
    },
    onSuccess: (_result, planId) => {
      queryClient.removeQueries({ queryKey: qk.plans.detail(planId) });
      void queryClient.invalidateQueries({ queryKey: qk.plans.lists() });
    },
  });
}

export interface LoadPlanScope {
  targetId: string;
  bundleId: string | null;
}

export function useLoadPlan({ targetId, bundleId }: LoadPlanScope) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: async (planId: string) => {
      const [plan, catalog] = await Promise.all([
        queryClient.fetchQuery({ ...planQuery(planId), staleTime: 0 }),
        queryClient.fetchQuery(catalogQuery({ targetId, bundleId, filters: {} })),
      ]);
      if (catalog.bundle_id === null) {
        throw new Error(
          "This target has no valid bundle, so a plan cannot be loaded into the catalog.",
        );
      }
      return { plan, catalog };
    },
  });
}
