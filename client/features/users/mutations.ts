import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { isApiError } from "@/lib/api/errors";
import { useIdempotencyKey } from "@/lib/api/idempotency";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import type { UserCreate, UserUpdate } from "@/lib/api/types";
import { unwrap } from "@/lib/api/unwrap";

export function useCreateUser() {
  const queryClient = useQueryClient();
  const idempotency = useIdempotencyKey();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: (body: UserCreate) =>
      unwrap(
        api.POST("/api/v1/users", {
          params: { header: { "Idempotency-Key": idempotency.key } },
          body,
        }),
      ),
    onSuccess: () => {
      idempotency.rotate();
      return queryClient.invalidateQueries({ queryKey: qk.users.lists() });
    },
    onError: (error) => {
      if (isApiError(error) && error.isClientError) {
        idempotency.rotate();
      }
    },
  });
}

export interface UpdateUserVariables {
  userId: string;
  update: UserUpdate;
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ userId, update }: UpdateUserVariables) =>
      unwrap(
        api.PATCH("/api/v1/users/{user_id}", {
          params: { path: { user_id: userId } },
          body: update,
        }),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.users.lists() }),
  });
}
