import { useState } from "react";
import { useFingerprintedKey } from "@/features/plans/use-fingerprinted-key";
import { useIssuePrompt, type PromptIssue } from "@/features/prompts";
import type { PromptIssueCreateAny } from "@/lib/api/types";

export interface PromptCardController {
  issued: PromptIssue | null;
  generate: (params: PromptIssueCreateAny) => void;
  isPending: boolean;
  error: unknown;
  reset: () => void;
}

export function usePromptCard(targetId: string): PromptCardController {
  const issuing = useIssuePrompt(targetId);
  const idempotency = useFingerprintedKey();
  const [issued, setIssued] = useState<PromptIssue | null>(null);

  function generate(params: PromptIssueCreateAny): void {
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

  return {
    issued,
    generate,
    isPending: issuing.isPending,
    error: issuing.error,
    reset: issuing.reset,
  };
}
