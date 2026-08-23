"use client";

import { useQuery } from "@tanstack/react-query";
import { FileArchive, LoaderCircle, Upload, X } from "lucide-react";
import { useId, useState } from "react";
import { FileDropZone } from "@/components/file-drop-zone";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatBytes } from "@/lib/format-bytes";
import { NOTE_MAX_LENGTH } from "../bundle-requests";
import { limitsQuery } from "../queries";
import type { BundleIntake } from "../use-bundle-intake";
import { IntakeProgress } from "./intake-progress";

export const ZIP_EXTENSIONS = [".zip"] as const;
export const ZIP_MEDIA_TYPES = ["application/zip", "application/x-zip-compressed"] as const;

export interface BundleDropZoneProps {
  intake: BundleIntake;
  disabled?: boolean;
}

export function BundleDropZone({ intake, disabled = false }: BundleDropZoneProps) {
  const limits = useQuery(limitsQuery());
  const noteId = useId();
  const [staged, setStaged] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const locked = disabled || intake.isBusy;
  const maxBytes = limits.data?.bundle_max_zip_bytes ?? null;
  const retrying =
    intake.outcome?.kind === "failed" &&
    intake.outcome.origin === "upload" &&
    intake.outcome.failure.retryable;

  async function submit(): Promise<void> {
    if (staged === null || locked) {
      return;
    }
    const outcome = await intake.upload(staged, note);
    if (outcome !== null && outcome.kind !== "failed") {
      setStaged(null);
      setNote("");
    }
  }

  const limitText =
    maxBytes === null
      ? limits.isError
        ? "The server limits could not be read. They are still enforced when you upload."
        : "Reading the server limits."
      : `A .zip of the tessa folder, at most ${formatBytes(maxBytes)}.`;

  return (
    <div className="flex flex-col gap-4">
      <FileDropZone
        title="Bundle zip"
        description={
          <>
            <p>{limitText}</p>
            <p>
              manifest.yaml must be at the root of the zip or directly inside a Tessa folder.
            </p>
          </>
        }
        extensions={ZIP_EXTENSIONS}
        acceptMediaTypes={ZIP_MEDIA_TYPES}
        maxBytes={maxBytes}
        disabled={locked}
        onFile={(file) => {
          setStaged(file);
          intake.dismiss();
        }}
      />
      {staged === null ? null : (
        <div
          data-slot="staged-file"
          className="flex flex-col gap-3 rounded-xl border p-4"
          aria-label="File ready to upload"
          role="group"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <FileArchive aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
              <div className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{staged.name}</span>
                <span className="text-xs text-muted-foreground">{formatBytes(staged.size)}</span>
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={locked}
              aria-label={`Remove ${staged.name}`}
              onClick={() => setStaged(null)}
            >
              <X aria-hidden="true" data-icon="inline-start" />
              Remove
            </Button>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={noteId}>Note (optional)</Label>
            <Input
              id={noteId}
              value={note}
              maxLength={NOTE_MAX_LENGTH}
              disabled={locked}
              autoComplete="off"
              placeholder="What changed in this version"
              onChange={(event) => setNote(event.target.value)}
            />
            <span className="text-xs text-muted-foreground">
              {note.length} of {NOTE_MAX_LENGTH} characters
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              disabled={locked}
              aria-busy={intake.busyOrigin === "upload"}
              onClick={() => void submit()}
            >
              {intake.busyOrigin === "upload" ? (
                <LoaderCircle
                  aria-hidden="true"
                  data-icon="inline-start"
                  className="animate-spin"
                />
              ) : (
                <Upload aria-hidden="true" data-icon="inline-start" />
              )}
              {intake.busyOrigin === "upload"
                ? "Validating"
                : retrying
                  ? "Try again"
                  : "Upload and validate"}
            </Button>
          </div>
        </div>
      )}
      {intake.busyOrigin === null ? null : (
        <IntakeProgress origin={intake.busyOrigin} startedAt={intake.startedAt} />
      )}
    </div>
  );
}
