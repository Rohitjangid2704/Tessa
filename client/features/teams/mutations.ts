import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useFingerprintedKey } from "@/features/plans/use-fingerprinted-key";
import { api } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import type { Team, TeamCreate } from "@/lib/api/types";
import { unwrap } from "@/lib/api/unwrap";

function refreshTeams(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: qk.teams.all() });
}

interface KeyedCreate {
  body: TeamCreate;
  idempotencyKey: string;
}

export interface CreateTeamOptions {
  onSuccess?: (team: Team) => void;
  onError?: (error: unknown) => void;
}

export function useCreateTeam() {
  const queryClient = useQueryClient();
  const idempotency = useFingerprintedKey();
  const mutation = useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ body, idempotencyKey }: KeyedCreate) =>
      unwrap(
        api.POST("/api/v1/teams", {
          params: { header: { "Idempotency-Key": idempotencyKey } },
          body,
        }),
      ),
    onSuccess: () => {
      idempotency.forget();
      refreshTeams(queryClient);
    },
    onError: (error) => {
      if (isApiError(error) && error.isClientError) {
        idempotency.forget();
      }
    },
  });

  function create(body: TeamCreate, options: CreateTeamOptions = {}): void {
    mutation.mutate(
      { body, idempotencyKey: idempotency.keyFor(body) },
      { onSuccess: options.onSuccess, onError: options.onError },
    );
  }

  return { create, isPending: mutation.isPending, error: mutation.error, reset: mutation.reset };
}

export interface RenameTeamVariables {
  teamId: string;
  name: string;
}

export function useRenameTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ teamId, name }: RenameTeamVariables) =>
      unwrap(
        api.PATCH("/api/v1/teams/{team_id}", {
          params: { path: { team_id: teamId } },
          body: { name },
        }),
      ),
    onSuccess: () => refreshTeams(queryClient),
  });
}

export interface SetTeamMembersVariables {
  teamId: string;
  userIds: readonly string[];
}

export function useSetTeamMembers() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ teamId, userIds }: SetTeamMembersVariables) =>
      unwrap(
        api.PUT("/api/v1/teams/{team_id}/members", {
          params: { path: { team_id: teamId } },
          body: { user_ids: [...userIds] },
        }),
      ),
    onSuccess: () => {
      refreshTeams(queryClient);
      void queryClient.invalidateQueries({ queryKey: qk.users.all() });
    },
  });
}

export interface SetTeamBudgetVariables {
  teamId: string;
  maxUsdMonth: number;
}

export function useSetTeamBudget() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ teamId, maxUsdMonth }: SetTeamBudgetVariables) =>
      unwrap(
        api.PUT("/api/v1/teams/{team_id}/budget", {
          params: { path: { team_id: teamId } },
          body: { max_usd_month: maxUsdMonth },
        }),
      ),
    onSuccess: () => refreshTeams(queryClient),
  });
}

export function useSetTargetTeam(targetId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: (teamId: string | null) =>
      unwrap(
        api.PATCH("/api/v1/targets/{target_id}", {
          params: { path: { target_id: targetId } },
          body: { team_id: teamId },
        }),
      ),
    onSuccess: (target) => {
      queryClient.setQueryData(qk.targets.detail(target.id), target);
      void queryClient.invalidateQueries({ queryKey: qk.targets.lists() });
      void queryClient.invalidateQueries({ queryKey: qk.targets.options() });
      refreshTeams(queryClient);
    },
  });
}
