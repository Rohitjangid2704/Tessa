import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { planPreviewQuery } from "./queries";
import { PREVIEW_DEBOUNCE_MS } from "./schemas";
import type { PlanCreate, PlanPreview } from "./types";
import { sameJson, useDebouncedValue } from "./use-debounced-value";

export interface PlanPreviewState {
  data: PlanPreview | undefined;
  isIdle: boolean;
  isUpdating: boolean;
  isPlaceholderData: boolean;
  isError: boolean;
  error: Error | null;
  retry: () => void;
}

export function usePlanPreview(body: PlanCreate | null): PlanPreviewState {
  const settled = useDebouncedValue(body, PREVIEW_DEBOUNCE_MS, sameJson);
  const query = useQuery({ ...planPreviewQuery(settled), placeholderData: keepPreviousData });
  const waiting = !sameJson(body, settled);

  if (body === null) {
    return {
      data: undefined,
      isIdle: true,
      isUpdating: false,
      isPlaceholderData: false,
      isError: false,
      error: null,
      retry: () => undefined,
    };
  }

  return {
    data: query.data,
    isIdle: false,
    isUpdating: waiting || query.isFetching,
    isPlaceholderData: waiting || query.isPlaceholderData,
    isError: query.isError && !waiting,
    error: query.error,
    retry: () => void query.refetch(),
  };
}
