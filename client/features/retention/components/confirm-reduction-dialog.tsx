"use client";

import { TriangleAlert } from "lucide-react";
import { TypedConfirmDialog } from "@/components/typed-confirm-dialog";
import { formatDateTime, formatUtc } from "@/components/date-time";
import type { RetentionReduction } from "../cutoff";
import { RETENTION_CONFIRM_PHRASE, RETENTION_FIELD_INFO } from "../schemas";

export interface ConfirmReductionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reductions: readonly RetentionReduction[];
  onConfirm: () => void;
  pending: boolean;
  error: string | null;
}

function describeDays(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}

export function ConfirmReductionDialog({
  open,
  onOpenChange,
  reductions,
  onConfirm,
  pending,
  error,
}: ConfirmReductionDialogProps) {
  return (
    <TypedConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Reduce retention?"
      description="The next sweep permanently deletes everything older than the dates below. Deleted data cannot be brought back."
      expectedText={RETENTION_CONFIRM_PHRASE}
      confirmLabel="Reduce retention"
      pendingLabel="Saving"
      pending={pending}
      error={error}
      onConfirm={() => onConfirm()}
    >
      <ul
        aria-label="What the reduction deletes"
        data-slot="reduction-list"
        className="flex flex-col gap-3"
      >
        {reductions.map((reduction) => (
          <li
            key={reduction.field}
            data-field={reduction.field}
            className="flex items-start gap-2 rounded-lg border p-3 text-sm"
          >
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">
                {`${RETENTION_FIELD_INFO[reduction.field].label}: ${describeDays(reduction.fromDays)} to ${describeDays(reduction.toDays)}`}
              </span>
              <span className="text-muted-foreground">
                {`Deletes ${RETENTION_FIELD_INFO[reduction.field].subject} older than `}
                <span className="font-medium text-foreground">
                  {formatDateTime(reduction.cutoffIso)}
                </span>
                {` (${formatUtc(reduction.cutoffIso)}). The date moves forward every day.`}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </TypedConfirmDialog>
  );
}
