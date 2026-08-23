"use client";

import { LoaderCircle } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { fieldMessagesFromApiError } from "@/lib/api/form-errors";
import { describeFindingUpdateError } from "../detail-mutations";
import { KNOWN_GAP_REASON_MAX_LENGTH, knownGapReasonSchema } from "../detail-schemas";

export type KnownGapMode = "move" | "edit";

export interface KnownGapDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: KnownGapMode;
  initialReason: string | null;
  pending: boolean;
  error: unknown;
  onSubmit: (reason: string) => void;
}

type KnownGapFormProps = Omit<KnownGapDialogProps, "open">;

function KnownGapForm({
  onOpenChange,
  mode,
  initialReason,
  pending,
  error,
  onSubmit,
}: KnownGapFormProps) {
  const reasonId = useId();
  const hintId = useId();
  const errorId = useId();
  const [reason, setReason] = useState(initialReason ?? "");
  const [localError, setLocalError] = useState<string | null>(null);

  const serverMessage =
    error === null || error === undefined
      ? null
      : (fieldMessagesFromApiError(error, ["known_gap_reason"]).byField.known_gap_reason ??
        describeFindingUpdateError(error));
  const requestId = error === null || error === undefined ? null : readRequestId(error);
  const shownError = localError ?? serverMessage;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (pending) {
      return;
    }
    const parsed = knownGapReasonSchema.safeParse(reason);
    if (!parsed.success) {
      setLocalError(parsed.error.issues[0]?.message ?? "Give a reason");
      return;
    }
    setLocalError(null);
    onSubmit(parsed.data);
  }

  return (
    <form noValidate onSubmit={handleSubmit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{mode === "move" ? "Mark as a known gap" : "Edit the known-gap reason"}</DialogTitle>
        <DialogDescription>
          A known gap stays on the board and new occurrences are counted without reopening it. Say
          why it is accepted so the next person does not have to ask.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={reasonId}>Reason</Label>
        <Textarea
          id={reasonId}
          value={reason}
          rows={4}
          autoComplete="off"
          disabled={pending}
          aria-required="true"
          aria-invalid={shownError !== null}
          aria-describedby={shownError === null ? hintId : `${hintId} ${errorId}`}
          onChange={(event) => {
            setReason(event.target.value);
            setLocalError(null);
          }}
        />
        <p id={hintId} className="text-xs text-muted-foreground">
          {reason.trim().length} of {KNOWN_GAP_REASON_MAX_LENGTH} characters, at least 3
        </p>
        {shownError === null ? null : (
          <p id={errorId} role="alert" className="text-xs font-medium text-destructive">
            {shownError}
            {requestId === null || localError !== null ? null : (
              <span className="ml-1 font-mono">Request ID: {requestId}</span>
            )}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending ? (
            <LoaderCircle aria-hidden="true" data-icon="inline-start" className="animate-spin" />
          ) : null}
          {mode === "move" ? "Mark as known gap" : "Save reason"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function KnownGapDialog({ open, onOpenChange, ...rest }: KnownGapDialogProps) {
  function handleOpenChange(next: boolean): void {
    if (!next && rest.pending) {
      return;
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <KnownGapForm onOpenChange={handleOpenChange} {...rest} />
      </DialogContent>
    </Dialog>
  );
}
