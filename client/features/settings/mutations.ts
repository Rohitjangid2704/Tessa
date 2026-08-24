import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import type { SecretName, ServiceName, SettingsPatch, SettingsRead } from "@/lib/api/types";
import { unwrap } from "@/lib/api/unwrap";

export interface SetSecretVariables {
  name: SecretName;
  value: string;
}

export function usePatchSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: (patch: SettingsPatch) => unwrap(api.PATCH("/api/v1/settings", { body: patch })),
    onSuccess: (settings) => {
      queryClient.setQueryData(qk.settings(), settings);
    },
  });
}

export function useSetSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    meta: INLINE_ERROR_META,
    mutationFn: ({ name, value }: SetSecretVariables) =>
      unwrap(
        api.PUT("/api/v1/settings/secrets/{name}", {
          params: { path: { name } },
          body: { value },
        }),
      ),
    onSuccess: (status, { name }) => {
      queryClient.setQueryData<SettingsRead>(qk.settings(), (current) =>
        current === undefined
          ? current
          : { ...current, secrets: { ...current.secrets, [name]: status } },
      );
    },
  });
}

export function useClearSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    meta: INLINE_ERROR_META,
    mutationFn: async (name: SecretName) => {
      await unwrap(api.DELETE("/api/v1/settings/secrets/{name}", { params: { path: { name } } }));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.settings() }),
  });
}

export function useTestService(service: ServiceName) {
  return useMutation({
    gcTime: 0,
    meta: INLINE_ERROR_META,
    mutationFn: () =>
      unwrap(api.POST("/api/v1/settings/test/{service}", { params: { path: { service } } })),
  });
}
