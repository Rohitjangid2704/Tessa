import { useMutation, useQueryClient } from "@tanstack/react-query";
import { startTransition, useOptimistic, useState } from "react";
import { toast } from "sonner";
import { readRequestId } from "@/components/states/request-id";
import { useFingerprintedKey } from "@/features/plans/use-fingerprinted-key";
import { api } from "@/lib/api/client";
import { describeApiError, isApiError } from "@/lib/api/errors";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";
import { unwrap } from "@/lib/api/unwrap";
import { invalidateProposalCaches } from "./feed";
import { applyItemChange, changedItemIds, type ItemChange } from "./selection";
import type { Plan, Proposal, ProposalItemChoice, ProposalItemUpdate } from "./types";

export interface UpdateOutcome {
  ok: boolean;
  failed: number;
  error: unknown;
}

export interface ItemPatch {
  itemId: string;
  choice: ProposalItemChoice;
  note?: string | null;
}

export function buildItemUpdate(patch: Pick<ItemPatch, "choice" | "note">): ProposalItemUpdate {
  const body: ProposalItemUpdate = { status: patch.choice };
  return patch.note === undefined ? body : { ...body, note: patch.note };
}

export function describeItemUpdateError(error: unknown): string {
  if (isApiError(error) && error.status === 409) {
    return "The proposal changed while you were editing. It was reloaded.";
  }
  return describeApiError(error);
}

export function usePatchProposalItem() {
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ itemId, choice, note }: ItemPatch) =>
      unwrap(
        api.PATCH("/api/v1/proposal-items/{item_id}", {
          params: { path: { item_id: itemId } },
          body: buildItemUpdate({ choice, note }),
        }),
      ),
  });
}

export interface UpdateProposalItems {
  proposal: Proposal | null;
  pendingIds: ReadonlySet<string>;
  announcement: string;
  update: (change: ItemChange) => Promise<UpdateOutcome>;
}

export function useUpdateProposalItem(
  targetId: string,
  base: Proposal | null,
): UpdateProposalItems {
  const queryClient = useQueryClient();
  const patch = usePatchProposalItem();
  const [proposal, applyOptimistic] = useOptimistic(base, applyItemChange);
  const [announcement, setAnnouncement] = useState("");

  function update(change: ItemChange): Promise<UpdateOutcome> {
    return new Promise((resolve) => {
      startTransition(async () => {
        applyOptimistic(change);
        const results = await Promise.allSettled(
          change.ids.map((itemId) =>
            patch.mutateAsync({ itemId, choice: change.choice, note: change.note }),
          ),
        );
        const failures = results.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        const firstError: unknown = failures[0]?.reason;
        if (failures.length > 0) {
          const requestId = readRequestId(firstError);
          const message = describeItemUpdateError(firstError);
          toast.error(
            failures.length === 1
              ? "Could not update the item"
              : `Could not update ${failures.length} items`,
            { description: requestId === null ? message : `${message} (request ${requestId})` },
          );
          setAnnouncement("Could not save the change. The items are back as they were");
        } else {
          setAnnouncement(
            change.ids.length === 1 ? "Item updated" : `${change.ids.length} items updated`,
          );
        }
        await invalidateProposalCaches(queryClient, targetId);
        resolve({ ok: failures.length === 0, failed: failures.length, error: firstError ?? null });
      });
    });
  }

  return {
    proposal,
    pendingIds: changedItemIds(base, proposal),
    announcement,
    update,
  };
}

export interface PlanFromProposalInput {
  itemIds: readonly string[];
  name?: string;
}

export function usePlanFromProposal(targetId: string) {
  const queryClient = useQueryClient();
  const idempotency = useFingerprintedKey();
  const mutation = useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: ({ body, idempotencyKey }: { body: ProposalPlanBody; idempotencyKey: string }) =>
      unwrap(
        api.POST("/api/v1/targets/{target_id}/proposal/plan", {
          params: { path: { target_id: targetId }, header: { "Idempotency-Key": idempotencyKey } },
          body,
        }),
      ),
    onSuccess: (plan) => {
      idempotency.forget();
      queryClient.setQueryData(qk.plans.detail(plan.id), plan);
      void queryClient.invalidateQueries({ queryKey: qk.plans.lists() });
    },
    onError: (error) => {
      if (isApiError(error) && error.isClientError) {
        idempotency.forget();
      }
    },
  });

  function createPlan(input: PlanFromProposalInput, onSuccess: (created: Plan) => void): void {
    const body: ProposalPlanBody = { item_ids: [...input.itemIds] };
    if (input.name !== undefined) {
      body.name = input.name;
    }
    mutation.mutate({ body, idempotencyKey: idempotency.keyFor(body) }, { onSuccess });
  }

  return {
    createPlan,
    isPending: mutation.isPending,
    error: mutation.error,
    reset: mutation.reset,
  };
}

type ProposalPlanBody = { item_ids: string[]; name?: string };

export function usePutProposal(targetId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: (yaml: string) =>
      unwrap(
        api.PUT("/api/v1/targets/{target_id}/proposal", {
          params: { path: { target_id: targetId } },
          body: { yaml },
        }),
      ),
    onSuccess: (proposal) => {
      queryClient.setQueryData(qk.proposals.current(targetId), proposal);
      void invalidateProposalCaches(queryClient, targetId);
    },
  });
}
