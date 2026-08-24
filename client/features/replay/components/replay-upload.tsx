"use client";

import { useQuery } from "@tanstack/react-query";
import { FileText, LoaderCircle, ShieldAlert, TriangleAlert, Upload, X } from "lucide-react";
import { useId, useState } from "react";
import { FileDropZone } from "@/components/file-drop-zone";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { limitsQuery } from "@/features/bundles/queries";
import { useTarget } from "@/features/targets/queries";
import { readRequestId } from "@/components/states/request-id";
import { useCan } from "@/lib/auth/can";
import { formatBytes } from "@/lib/format-bytes";
import { useHydrated } from "@/lib/use-hydrated";
import {
  REPLAY_PRIVACY_NOTICE_LINES,
  REPLAY_PRIVACY_NOTICE_TITLE,
  REPLAY_PRODUCTION_BLOCKED_REASON,
} from "../labels";
import { useUploadReplay } from "../mutations";
import { checkReplayFile, type ReplayPreCheck } from "../precheck";
import { REPLAY_EXTENSIONS, replayNoteSchema } from "../schemas";
import { describeReplayUploadFailure } from "../upload-errors";

export type ReplayUploadProps = {
  targetId: string;
};

type Staged = { file: File; check: ReplayPreCheck | "checking" };

const PERCENT = 100;

function PrivacyNotice() {
  return (
    <Alert role="note" data-slot="replay-privacy-notice">
      <ShieldAlert aria-hidden="true" />
      <AlertTitle>{REPLAY_PRIVACY_NOTICE_TITLE}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc pl-5">
          {REPLAY_PRIVACY_NOTICE_LINES.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

function CheckSummary({ check }: { check: ReplayPreCheck | "checking" }) {
  if (check === "checking") {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
        Checking the file
      </p>
    );
  }
  if (!check.ok) {
    return (
      <div role="alert" data-slot="replay-precheck-problems" className="flex flex-col gap-1 text-sm">
        <p className="font-medium text-destructive">This file cannot be uploaded</p>
        <ul className="list-disc pl-5 text-destructive">
          {check.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <p role="status" data-slot="replay-precheck-ok" className="text-sm text-muted-foreground">
      {check.checkedRecords === 0
        ? "The file looks like a JSON export. The server reads every record and explains each one it rejects."
        : `The first ${check.checkedRecords} ${check.checkedRecords === 1 ? "record" : "records"} have a conversation_id and messages. The server reads every record and explains each one it rejects.`}
    </p>
  );
}

export function ReplayUpload({ targetId }: ReplayUploadProps) {
  const hydrated = useHydrated();
  const noteId = useId();
  const noteErrorId = useId();
  const reasonId = useId();
  const canUpload = useCan("replay.upload");
  const target = useTarget(targetId);
  const limits = useQuery(limitsQuery());
  const upload = useUploadReplay();
  const [staged, setStaged] = useState<Staged | null>(null);
  const [note, setNote] = useState("");

  const production = target.data?.tier === "production";
  const maxBytes = limits.data?.replay_max_bytes ?? null;
  const limitsReady = limits.isSuccess;
  const noteCheck = replayNoteSchema.safeParse(note);
  const noteError = noteCheck.success ? undefined : noteCheck.error.issues[0]?.message;
  const failure = upload.error === null ? null : describeReplayUploadFailure(upload.error);

  const checkReady = staged !== null && staged.check !== "checking" && staged.check.ok;
  const blocker = !hydrated
    ? null
    : !canUpload
      ? "Uploading needs the member role."
      : production
        ? REPLAY_PRODUCTION_BLOCKED_REASON
        : target.isPending
          ? "Loading the target."
          : !limitsReady
            ? limits.isError
              ? "The server limits could not be read. Reload the page to try again."
              : "Reading the server limits."
            : staged === null
              ? "Choose an export first."
              : staged.check === "checking"
                ? "Checking the file."
                : !staged.check.ok
                  ? (staged.check.problems[0] ?? "The file did not pass the check.")
                  : noteError !== undefined
                    ? noteError
                    : null;
  const dropDisabled = !hydrated || !canUpload || production || !limitsReady || upload.isPending;
  const submitDisabled = blocker !== null || !checkReady || upload.isPending;
  const fraction = upload.progress?.fraction ?? null;
  const percent = fraction === null ? null : Math.round(fraction * PERCENT);
  const sent = percent === PERCENT;

  async function handleFile(file: File): Promise<void> {
    upload.reset();
    setStaged({ file, check: "checking" });
    const check = await checkReplayFile(file, maxBytes);
    setStaged((current) => (current?.file === file ? { file, check } : current));
  }

  function submit(): void {
    if (submitDisabled || staged === null) {
      return;
    }
    upload.upload(staged.file, targetId, note);
  }

  return (
    <div data-slot="replay-upload" className="flex flex-col gap-4">
      <PrivacyNotice />
      {production ? (
        <Alert role="status" data-slot="replay-production-blocked" data-code="production_blocked">
          <ShieldAlert aria-hidden="true" />
          <AlertTitle>{target.data?.name} is a production target</AlertTitle>
          <AlertDescription>{REPLAY_PRODUCTION_BLOCKED_REASON}</AlertDescription>
        </Alert>
      ) : null}
      {hydrated && !canUpload ? (
        <p role="status" data-slot="viewer-note" className="text-sm text-muted-foreground">
          You can read this page. Uploading an export needs the member or admin role.
        </p>
      ) : null}
      <FileDropZone
        title="Production export"
        description={
          <>
            <p>
              A .jsonl file with one conversation per line, or a .json array. Every record needs a
              conversation_id and a messages list.
            </p>
            <p>
              {maxBytes === null
                ? limits.isError
                  ? "The server limits could not be read. They are still enforced when you upload."
                  : "Reading the server limits."
                : `At most ${formatBytes(maxBytes)}.`}
            </p>
          </>
        }
        extensions={REPLAY_EXTENSIONS}
        maxBytes={maxBytes}
        disabled={dropDisabled}
        onFile={(file) => void handleFile(file)}
      />
      {staged === null ? null : (
        <div
          data-slot="staged-replay"
          role="group"
          aria-label="Export ready to upload"
          className="flex flex-col gap-3 rounded-xl border p-4"
        >
          <div className="flex flex-wrap items-center gap-2">
            <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <span className="font-medium break-all">{staged.file.name}</span>
            <span className="text-sm text-muted-foreground">{formatBytes(staged.file.size)}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto"
              disabled={upload.isPending}
              onClick={() => {
                setStaged(null);
                upload.reset();
              }}
            >
              <X aria-hidden="true" data-icon="inline-start" />
              Choose another file
            </Button>
          </div>
          <CheckSummary check={staged.check} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={noteId}>Note (optional)</Label>
            <Input
              id={noteId}
              type="text"
              autoComplete="off"
              value={note}
              disabled={upload.isPending}
              aria-invalid={noteError === undefined ? undefined : true}
              aria-describedby={noteError === undefined ? undefined : noteErrorId}
              onChange={(event) => setNote(event.target.value)}
            />
            {noteError === undefined ? null : (
              <p id={noteErrorId} role="alert" className="text-xs text-destructive">
                {noteError}
              </p>
            )}
          </div>
          {upload.isPending ? (
            <div data-slot="replay-upload-progress" className="flex flex-col gap-2">
              <Progress
                value={percent ?? 0}
                aria-label="Upload progress"
                aria-valuetext={
                  sent
                    ? "Sent, the server is reading the export"
                    : percent === null
                      ? "Uploading"
                      : `${percent} percent uploaded`
                }
              />
              <p role="status" className="text-sm text-muted-foreground">
                {sent
                  ? "Sent. The server is reading the export."
                  : upload.progress === null || upload.progress.total === null
                    ? "Uploading."
                    : `Uploading ${formatBytes(upload.progress.loaded)} of ${formatBytes(upload.progress.total)}.`}
              </p>
            </div>
          ) : null}
          {failure === null ? null : (
            <Alert variant="destructive" data-slot="replay-upload-error" data-problem={failure.kind}>
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>{failure.title}</AlertTitle>
              <AlertDescription>
                <p>{failure.message}</p>
                {failure.issues.length > 0 ? (
                  <ul className="list-disc pl-5">
                    {failure.issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                ) : null}
                {failure.nextStep === null ? null : <p>{failure.nextStep}</p>}
                {readRequestId(upload.error) === null ? null : (
                  <p className="font-mono text-xs">Request ID: {readRequestId(upload.error)}</p>
                )}
              </AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              disabled={submitDisabled}
              aria-busy={upload.isPending}
              aria-describedby={blocker === null ? undefined : reasonId}
              onClick={submit}
            >
              {upload.isPending ? (
                <LoaderCircle
                  aria-hidden="true"
                  data-icon="inline-start"
                  className="animate-spin motion-reduce:animate-none"
                />
              ) : (
                <Upload aria-hidden="true" data-icon="inline-start" />
              )}
              {upload.isPending ? "Uploading" : failure?.retryable === true ? "Try again" : "Upload and replay"}
            </Button>
            {upload.isPending ? (
              <Button type="button" variant="outline" onClick={upload.cancel}>
                Cancel the upload
              </Button>
            ) : null}
            {blocker === null ? null : (
              <p id={reasonId} data-slot="replay-blocker" className="text-sm text-muted-foreground">
                {blocker}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
