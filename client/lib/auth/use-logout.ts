import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useTransition } from "react";
import { logoutAction } from "@/app/(auth)/login/actions";
import { clearToken } from "./token-client";

export function useLogout() {
  const queryClient = useQueryClient();
  const [pending, startTransition] = useTransition();

  const logout = useCallback(() => {
    clearToken();
    queryClient.clear();
    startTransition(async () => {
      await logoutAction();
    });
  }, [queryClient]);

  return { logout, pending } as const;
}
