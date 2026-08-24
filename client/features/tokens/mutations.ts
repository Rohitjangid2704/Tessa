import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import type { PersonalTokenCreate } from "@/lib/api/types";
import { unwrap } from "@/lib/api/unwrap";

export function useCreateToken() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    gcTime: 0,
    mutationFn: (body: PersonalTokenCreate) =>
      unwrap(api.POST("/api/v1/users/me/tokens", { body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.tokens.mine() }),
  });
}

export function useRevokeToken() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: (tokenId: string) =>
      unwrap(
        api.DELETE("/api/v1/users/me/tokens/{token_id}", {
          params: { path: { token_id: tokenId } },
        }),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.tokens.mine() }),
  });
}

export interface RevokeUserTokenVariables {
  userId: string;
  tokenId: string;
}

export function useRevokeUserToken() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ userId, tokenId }: RevokeUserTokenVariables) =>
      unwrap(
        api.DELETE("/api/v1/users/{user_id}/tokens/{token_id}", {
          params: { path: { user_id: userId, token_id: tokenId } },
        }),
      ),
    onSettled: (_result, _error, { userId }) =>
      queryClient.invalidateQueries({ queryKey: qk.tokens.forUser(userId) }),
  });
}
