"use client";

import { useQuery } from "@tanstack/react-query";
import { ClipboardPaste, LoaderCircle } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatBytes } from "@/lib/format-bytes";
import { NOTE_MAX_LENGTH } from "../bundle-requests";
import { limitsQuery } from "../queries";
import type { BundleIntake } from "../use-bundle-intake";
import { UploadFailureAlert } from "./upload-result";

export interface PasteManifestDialogProps {
  intake: BundleIntake;
  disabled?: boolean;
}

const encoder = new TextEncoder();

export function PasteManifestDialog({ intake, disabled = false }: PasteManifestDialogProps) {
  const limits = useQuery(limitsQuery());
  const textId = useId();
  const sizeId = useId();
  const noteId = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");

  const maxBytes = limits.data?.bundle_max_manifest_bytes ?? null;
  const byteLength = encoder.encode(text).length;
  const tooLarge = maxBytes !== null && byteLength > maxBytes;
  const empty = text.trim() === "";
  const locked = intake.isBusy;
  const failure =
    intake.outcome?.kind === "failed" && intake.outcome.origin === "paste" ? intake.outcome : null;
  const pasting = intake.busyOrigin === "paste";

  function handleOpenChange(next: boolean): void {
    if (!next && locked) {
      return;
    }
    setOpen(next);
    if (!next && failure !== null) {
      intake.dismiss();
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (empty || tooLarge || locked) {
      return;
    }
    const outcome = await intake.paste(text, note);
    if (outcome !== null && outcome.kind !== "failed") {
      setOpen(false);
      setText("");
      setNote("");
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" disabled={disabled || (locked && !open)}>
          <ClipboardPaste aria-hidden="true" data-icon="inline-start" />
          Paste manifest instead
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Paste manifest.yaml</DialogTitle>
            <DialogDescription>
              A pasted manifest has no env.template, oracle or seed files next to it, so it usually
              scores below the completeness bar. Upload the zip for the full check.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={textId}>manifest.yaml</Label>
            <Textarea
              id={textId}
              value={text}
              rows={14}
              spellCheck={false}
              autoComplete="off"
              disabled={locked}
              aria-describedby={sizeId}
              aria-invalid={tooLarge}
              placeholder="schema: https://.../schemas/bundle.v1.json"
              className="max-h-96 overflow-y-auto font-mono text-xs"
              onChange={(event) => setText(event.target.value)}
            />
            <p
              id={sizeId}
              className={
                tooLarge ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"
              }
            >
              {maxBytes === null
                ? `${formatBytes(byteLength)}. The server limit could not be read yet and is enforced when you submit.`
                : tooLarge
                  ? `${formatBytes(byteLength)} is over the limit of ${formatBytes(maxBytes)}. Shorten the manifest.`
                  : `${formatBytes(byteLength)} of ${formatBytes(maxBytes)}`}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={noteId}>Note (optional)</Label>
            <Input
              id={noteId}
              value={note}
              maxLength={NOTE_MAX_LENGTH}
              disabled={locked}
              autoComplete="off"
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          {failure === null ? null : (
            <UploadFailureAlert failure={failure.failure} sourceName={null} />
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={locked}
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={empty || tooLarge || locked} aria-busy={pasting}>
              {pasting ? (
                <LoaderCircle
                  aria-hidden="true"
                  data-icon="inline-start"
                  className="animate-spin"
                />
              ) : null}
              {pasting ? "Validating" : failure?.failure.retryable ? "Try again" : "Add version"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
