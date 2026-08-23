import { useState } from "react";
import { useFingerprintedKey } from "@/features/plans/use-fingerprinted-key";
import { useIssuePrompt, type PromptIssue } from "@/features/prompts";
import type { AuthorPromptParams } from "./types";

export interface AuthorPromptController {
  open: boolean;
  setOpen: (open: boolean) => void;
  request: (cellIds: readonly string[], itemIds?: readonly string[]) => void;
  regenerate: () => void;
  cellCount: number;
  cellIds: readonly string[];
  itemIds: readonly string[];
  issued: PromptIssue | null;
  isPending: boolean;
  error: unknown;
}

export function buildAuthorParams(cellIds: readonly string[]): AuthorPromptParams {
  return { template_name: "author", cell_ids: [...cellIds] };
}

export function useAuthorPrompt(targetId: string): AuthorPromptController {
  const issuing = useIssuePrompt(targetId);
  const idempotency = useFingerprintedKey();
  const [open, setOpen] = useState(false);
  const [cellIds, setCellIds] = useState<readonly string[]>([]);
  const [itemIds, setItemIds] = useState<readonly string[]>([]);
  const [issued, setIssued] = useState<PromptIssue | null>(null);

  function issue(ids: readonly string[]): void {
    const params = buildAuthorParams(ids);
    issuing.mutate(
      { params, idempotencyKey: idempotency.keyFor(params) },
      {
        onSuccess: (created) => {
          idempotency.forget();
          setIssued(created);
        },
      },
    );
  }

  function request(ids: readonly string[], proposalItemIds: readonly string[] = []): void {
    setCellIds(ids);
    setItemIds(proposalItemIds);
    setIssued(null);
    setOpen(true);
    issue(ids);
  }

  function regenerate(): void {
    setIssued(null);
    issue(cellIds);
  }

  return {
    open,
    setOpen,
    request,
    regenerate,
    cellCount: cellIds.length,
    cellIds,
    itemIds,
    issued,
    isPending: issuing.isPending,
    error: issuing.error,
  };
}
