import { useQueryClient } from "@tanstack/react-query";
import { startTransition, useOptimistic, useState } from "react";
import { toast } from "sonner";
import { readRequestId } from "@/components/states/request-id";
import { qk } from "@/lib/api/query-keys";
import type { FindingStatus, FindingSummary } from "@/lib/api/types";
import {
  moveDeltas,
  movedIds,
  reorderForMove,
  type OptimisticMove,
  type StatusDeltas,
} from "../board-model";
import { describeFindingUpdateError } from "../detail-mutations";
import { buildStatusUpdate, FINDING_STATUS_LABELS } from "../detail-schemas";
import { useUpdateFinding } from "../mutations";

export interface MoveOutcome {
  ok: boolean;
  error: unknown;
}

export interface MoveOptions {
  knownGapReason?: string | null;
  reportErrors?: boolean;
}

export interface MoveFinding {
  cards: readonly FindingSummary[];
  movingIds: ReadonlySet<string>;
  deltas: StatusDeltas;
  announcement: string;
  move: (
    finding: FindingSummary,
    to: FindingStatus,
    options?: MoveOptions,
  ) => Promise<MoveOutcome>;
}

function focusMovedCard(findingId: string): void {
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (active !== null && active !== document.body) {
      return;
    }
    document
      .querySelector<HTMLElement>(`[data-finding-open="${CSS.escape(findingId)}"]`)
      ?.focus();
  });
}

export function useMoveFinding(baseCards: readonly FindingSummary[]): MoveFinding {
  const queryClient = useQueryClient();
  const update = useUpdateFinding();
  const [cards, applyOptimisticMove] = useOptimistic(baseCards, reorderForMove);
  const [announcement, setAnnouncement] = useState("");

  function move(
    finding: FindingSummary,
    to: FindingStatus,
    options: MoveOptions = {},
  ): Promise<MoveOutcome> {
    const { knownGapReason = null, reportErrors = true } = options;
    const optimisticMove: OptimisticMove = { findingId: finding.id, to, knownGapReason };
    return new Promise((resolve) => {
      startTransition(async () => {
        applyOptimisticMove(optimisticMove);
        try {
          await update.mutateAsync({
            findingId: finding.id,
            patch: buildStatusUpdate(to, knownGapReason),
          });
          await queryClient.invalidateQueries({ queryKey: qk.findings.lists() });
          setAnnouncement(`Moved ${finding.title} to ${FINDING_STATUS_LABELS[to]}`);
          focusMovedCard(finding.id);
          resolve({ ok: true, error: null });
        } catch (error) {
          if (reportErrors) {
            const requestId = readRequestId(error);
            const message = describeFindingUpdateError(error);
            toast.error("Could not move the finding", {
              description: requestId === null ? message : `${message} (request ${requestId})`,
            });
          }
          const home = FINDING_STATUS_LABELS[finding.status];
          setAnnouncement(`Could not move ${finding.title}. It is back in ${home}`);
          await queryClient.invalidateQueries({ queryKey: qk.findings.lists() });
          resolve({ ok: false, error });
        }
      });
    });
  }

  return {
    cards,
    movingIds: movedIds(baseCards, cards),
    deltas: moveDeltas(baseCards, cards),
    announcement,
    move,
  };
}
