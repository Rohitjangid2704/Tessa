import { useState } from "react";
import type { FindingSummary } from "@/lib/api/types";
import type { MoveFinding } from "./use-move-finding";

export interface KnownGapMove {
  target: FindingSummary | null;
  pending: boolean;
  error: unknown;
  open: (finding: FindingSummary) => void;
  close: () => void;
  submit: (reason: string) => void;
}

export function useKnownGapMove(move: MoveFinding["move"]): KnownGapMove {
  const [target, setTarget] = useState<FindingSummary | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  function open(finding: FindingSummary): void {
    setError(null);
    setTarget(finding);
  }

  function close(): void {
    setError(null);
    setTarget(null);
  }

  function submit(reason: string): void {
    if (target === null || pending) {
      return;
    }
    setPending(true);
    setError(null);
    void move(target, "known_gap", { knownGapReason: reason, reportErrors: false }).then(
      (outcome) => {
        setPending(false);
        if (outcome.ok) {
          setTarget(null);
        } else {
          setError(outcome.error);
        }
      },
    );
  }

  return { target, pending, error, open, close, submit };
}
