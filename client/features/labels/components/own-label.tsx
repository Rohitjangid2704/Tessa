"use client";

import { Tag } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { describeApiError } from "@/lib/api/errors";
import type { LabelSubjectType } from "@/lib/api/types";
import { useCan } from "@/lib/auth/can";
import { cn } from "@/lib/utils";
import { useHydrated } from "@/lib/use-hydrated";
import { useDeleteLabel } from "../mutations";
import { useOwnLabel } from "../queries";
import { LABEL_SUBJECT_NOUNS } from "../schemas";
import { LabelDialog } from "./label-dialog";

export interface OwnLabelChipProps {
  subjectType: LabelSubjectType;
  subjectId: string;
  stepId?: string | null;
  runId?: string | null;
  className?: string;
}

export function OwnLabelChip({
  subjectType,
  subjectId,
  stepId,
  runId,
  className,
}: OwnLabelChipProps) {
  const hydrated = useHydrated();
  const canLabel = useCan("labels.create");
  const canDelete = useCan("labels.delete");
  const own = useOwnLabel(subjectType, subjectId);
  const deleteLabel = useDeleteLabel();
  const [changing, setChanging] = useState(false);
  const noun = LABEL_SUBJECT_NOUNS[subjectType];

  if (!hydrated || own.isPending) {
    return null;
  }

  if (own.isError) {
    const requestId = readRequestId(own.error);
    return (
      <div
        role="alert"
        data-slot="own-label-error"
        className={cn("flex flex-wrap items-center gap-2 text-sm", className)}
      >
        <span>
          Could not check your label of this {noun}. {describeApiError(own.error)}
          {requestId === null ? "" : ` (request ${requestId})`}
        </span>
        <Button type="button" variant="outline" size="xs" onClick={() => void own.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const label = own.label;
  if (label === null) {
    return null;
  }

  function undo(): void {
    if (label === null) {
      return;
    }
    deleteLabel.mutate(
      { label, runId },
      {
        onSuccess: () => toast.success(`Removed your label of this ${noun}`),
        onError: (error) =>
          toast.error("Could not remove your label", { description: describeApiError(error) }),
      },
    );
  }

  return (
    <div
      data-slot="own-label"
      data-value={label.value}
      className={cn(
        "inline-flex flex-wrap items-center gap-x-1 gap-y-1 rounded-full border py-0.5 pr-1 pl-2.5 text-sm",
        className,
      )}
    >
      <Tag aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <span data-slot="own-label-text" className="pr-1">
        you labeled: {label.value}
      </span>
      {canLabel ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={`Change your label of this ${noun}`}
          onClick={() => setChanging(true)}
        >
          Change
        </Button>
      ) : null}
      {canDelete ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={deleteLabel.isPending}
          aria-label={`Undo your label of this ${noun}`}
          onClick={undo}
        >
          Undo
        </Button>
      ) : null}
      {canLabel ? (
        <LabelDialog
          subjectType={subjectType}
          subjectId={subjectId}
          stepId={stepId}
          runId={runId}
          open={changing}
          onOpenChange={setChanging}
          initialValue={label.value}
          initialNote={label.note ?? undefined}
        />
      ) : null}
    </div>
  );
}
