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
import { describeApiError } from "@/lib/api/errors";
import { fieldMessagesFromApiError } from "@/lib/api/form-errors";
import { REVIEW_NOTE_MAX_LENGTH, reviewFormSchema } from "../schemas";

export type RejectDialogProps = {
  open: boolean;
  scenarioTitle: string;
  pending: boolean;
  error: unknown;
  onOpenChange: (open: boolean) => void;
  onConfirm: (note: string) => void;
};

type RejectFormProps = Omit<RejectDialogProps, "open" | "onOpenChange"> & {
  onCancel: () => void;
};

function RejectForm({ scenarioTitle, pending, error, onConfirm, onCancel }: RejectFormProps) {
  const noteId = useId();
  const errorId = useId();
  const [note, setNote] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const serverFieldError = fieldMessagesFromApiError(error, ["note"]).byField.note;
  const noteError = localError ?? serverFieldError ?? null;
  const generalError =
    error !== null && error !== undefined && serverFieldError === undefined
      ? describeApiError(error)
      : null;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (pending) {
      return;
    }
    const parsed = reviewFormSchema.safeParse({ decision: "reject", note });
    if (!parsed.success) {
      setLocalError(parsed.error.issues[0]?.message ?? "Say why this scenario is rejected");
      return;
    }
    if (parsed.data.decision === "reject") {
      setLocalError(null);
      onConfirm(parsed.data.note);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>Reject this scenario?</DialogTitle>
        <DialogDescription>
          {`"${scenarioTitle}" leaves the review queue and is not run. Say why, so the next person who writes or generates it can learn from it.`}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={noteId}>Reason for rejecting</Label>
        <Textarea
          id={noteId}
          value={note}
          rows={4}
          maxLength={REVIEW_NOTE_MAX_LENGTH}
          required
          autoComplete="off"
          disabled={pending}
          aria-invalid={noteError !== null}
          aria-describedby={noteError === null ? undefined : errorId}
          onChange={(event) => {
            setNote(event.target.value);
            setLocalError(null);
          }}
        />
        {noteError === null ? null : (
          <p id={errorId} role="alert" className="text-sm text-destructive">
            {noteError}
          </p>
        )}
      </div>
      {generalError === null ? null : (
        <div role="alert" className="flex flex-col gap-1 text-sm text-destructive">
          <p>{generalError}</p>
          {readRequestId(error) === null ? null : (
            <p className="font-mono text-xs text-muted-foreground">
              Request ID: {readRequestId(error)}
            </p>
          )}
        </div>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="destructive" disabled={pending} aria-busy={pending}>
          {pending ? (
            <LoaderCircle aria-hidden="true" data-icon="inline-start" className="animate-spin" />
          ) : null}
          {pending ? "Rejecting" : "Reject scenario"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function RejectDialog({ open, onOpenChange, ...props }: RejectDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => (props.pending ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-lg">
        <RejectForm {...props} onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
