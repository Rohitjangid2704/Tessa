import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import type { FindingUpdate } from "@/lib/api/types";
import { unwrap } from "@/lib/api/unwrap";
import { beginLocalMove, endLocalMove } from "./local-moves";

export interface UpdateFindingVariables {
  findingId: string;
  patch: FindingUpdate;
}

export function useUpdateFinding() {
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ findingId, patch }: UpdateFindingVariables) =>
      unwrap(
        api.PATCH("/api/v1/findings/{finding_id}", {
          params: { path: { finding_id: findingId } },
          body: patch,
        }),
      ),
    onMutate: ({ findingId }) => {
      beginLocalMove(findingId);
    },
    onSuccess: (finding, { findingId }) => {
      endLocalMove(findingId, finding.status, Date.now());
    },
    onError: (_error, { findingId }) => {
      endLocalMove(findingId, null, Date.now());
    },
  });
}
