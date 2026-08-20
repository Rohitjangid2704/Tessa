import { MutationCache, QueryCache, QueryClient, environmentManager } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastRoleRequired, toastTeamBudgetExceeded } from "./error-toasts";
import { describeApiError, isApiError } from "./errors";
import { qk } from "./query-keys";

export const QUERY_STALE_TIME_MS = 30_000;
export const MAX_QUERY_RETRIES = 2;

export interface ApiErrorMeta extends Record<string, unknown> {
  errorToast?: boolean;
  budgetToast?: boolean;
}

export const INLINE_ERROR_META: ApiErrorMeta = { errorToast: false };

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: ApiErrorMeta;
    mutationMeta: ApiErrorMeta;
  }
}

export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && error.isClientError) {
    return false;
  }
  return failureCount < MAX_QUERY_RETRIES;
}

export function refreshCurrentUser(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.me() }, { cancelRefetch: false });
}

export function notifyApiError(error: unknown, meta?: ApiErrorMeta): void {
  if (!isApiError(error)) {
    return;
  }
  if (error.isTeamBudgetExceeded && meta?.budgetToast !== false) {
    toastTeamBudgetExceeded(error);
    return;
  }
  if (meta?.errorToast === false) {
    return;
  }
  if (error.isRoleRequired) {
    toastRoleRequired(error);
    return;
  }
  if (error.status === 429) {
    toast.error("Rate limited", {
      id: "api-error-429",
      description: describeApiError(error),
    });
    return;
  }
  if (error.isServerError || error.isNetworkError) {
    toast.error(error.isNetworkError ? "Cannot reach the API" : "Server error", {
      id: `api-error-${error.status}-${error.code}`,
      description: error.requestId
        ? `${describeApiError(error)} (request ${error.requestId})`
        : describeApiError(error),
    });
  }
}

export function handleApiError(client: QueryClient, error: unknown, meta?: ApiErrorMeta): void {
  if (isApiError(error) && error.isRoleRequired) {
    void refreshCurrentUser(client);
  }
  notifyApiError(error, meta);
}

export function makeQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: QUERY_STALE_TIME_MS,
        retry: shouldRetryQuery,
      },
      mutations: {
        retry: false,
      },
    },
    queryCache: new QueryCache({
      onError: (error, query) => handleApiError(client, error, query.meta),
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _onMutateResult, mutation) =>
        handleApiError(client, error, mutation.meta),
    }),
  });
  return client;
}

let browserQueryClient: QueryClient | undefined;

export function getQueryClient(): QueryClient {
  if (environmentManager.isServer()) {
    return makeQueryClient();
  }
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}
