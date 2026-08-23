import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { qk } from "@/lib/api/query-keys";
import {
  pasteManifestRequest,
  uploadBundleRequest,
  type PasteManifestInput,
  type UploadBundleInput,
} from "./bundle-requests";

export function invalidateAfterIntake(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: qk.targets.all() });
  void queryClient.invalidateQueries({ queryKey: qk.catalogRoot() });
  void queryClient.invalidateQueries({ queryKey: qk.mutants.all() });
}

export function useUploadBundle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UploadBundleInput) => uploadBundleRequest(api, input),
    onSuccess: (result) => {
      if (result.created) {
        invalidateAfterIntake(queryClient);
      }
    },
  });
}

export function usePasteManifest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PasteManifestInput) => pasteManifestRequest(api, input),
    onSuccess: (result) => {
      if (result.created) {
        invalidateAfterIntake(queryClient);
      }
    },
  });
}
