import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import { useStartRun } from "@/features/runs/start-mutation";
import type { GoalCreate, GoalUpdate, PersonaCreate, PersonaUpdate, SimulationCreate } from "./types";

export interface CreatePersonaVariables {
  body: PersonaCreate;
  idempotencyKey: string;
}

export interface UpdatePersonaVariables {
  personaId: string;
  body: PersonaUpdate;
}

export interface CreateGoalVariables {
  body: GoalCreate;
  idempotencyKey: string;
}

export interface UpdateGoalVariables {
  goalId: string;
  body: GoalUpdate;
}

export const SIMULATOR_IN_USE_CODE = "conflict";

export function isInUseConflict(error: unknown): boolean {
  return isApiError(error) && error.status === 409 && error.code === SIMULATOR_IN_USE_CODE;
}

export function useCreatePersona() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ body, idempotencyKey }: CreatePersonaVariables) =>
      unwrap(
        api.POST("/api/v1/personas", {
          params: { header: { "Idempotency-Key": idempotencyKey } },
          body,
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.personas.all() }),
  });
}

export function useUpdatePersona() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ personaId, body }: UpdatePersonaVariables) =>
      unwrap(
        api.PATCH("/api/v1/personas/{persona_id}", {
          params: { path: { persona_id: personaId } },
          body,
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.personas.all() }),
  });
}

export function useDeletePersona() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: async (personaId: string) => {
      await unwrap(
        api.DELETE("/api/v1/personas/{persona_id}", { params: { path: { persona_id: personaId } } }),
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.personas.all() }),
  });
}

export function useCreateGoal() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ body, idempotencyKey }: CreateGoalVariables) =>
      unwrap(
        api.POST("/api/v1/goals", {
          params: { header: { "Idempotency-Key": idempotencyKey } },
          body,
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.goals.all() }),
  });
}

export function useUpdateGoal() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ goalId, body }: UpdateGoalVariables) =>
      unwrap(
        api.PATCH("/api/v1/goals/{goal_id}", {
          params: { path: { goal_id: goalId } },
          body,
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.goals.all() }),
  });
}

export function useDeleteGoal() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: async (goalId: string) => {
      await unwrap(
        api.DELETE("/api/v1/goals/{goal_id}", { params: { path: { goal_id: goalId } } }),
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.goals.all() }),
  });
}

export function useStartSimulation() {
  return useStartRun<SimulationCreate>((body, idempotencyKey) =>
    unwrap(
      api.POST("/api/v1/simulations", {
        params: { header: { "Idempotency-Key": idempotencyKey } },
        body,
      }),
    ),
  );
}
