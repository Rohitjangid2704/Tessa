import { useState } from "react";
import type { BundleUploadResult } from "./bundle-requests";
import { usePasteManifest, useUploadBundle } from "./mutations";
import { describeUploadFailure, type UploadFailure } from "./upload-errors";
import { fileFingerprint, textFingerprint, useAttemptKeys } from "./use-attempt-keys";

export type IntakeOrigin = "upload" | "paste";

export type IntakeOutcome =
  | { kind: "created"; origin: IntakeOrigin; result: BundleUploadResult; sourceName: string | null }
  | {
      kind: "identical";
      origin: IntakeOrigin;
      result: BundleUploadResult;
      sourceName: string | null;
    }
  | { kind: "failed"; origin: IntakeOrigin; failure: UploadFailure; sourceName: string | null };

export interface BundleIntake {
  isBusy: boolean;
  busyOrigin: IntakeOrigin | null;
  startedAt: number | null;
  outcome: IntakeOutcome | null;
  upload: (file: File, note: string) => Promise<IntakeOutcome | null>;
  paste: (manifestYaml: string, note: string) => Promise<IntakeOutcome | null>;
  dismiss: () => void;
}

const PASTE_SOURCE_NAME = "Pasted manifest";

function successOutcome(
  origin: IntakeOrigin,
  result: BundleUploadResult,
  sourceName: string,
): IntakeOutcome {
  return { kind: result.created ? "created" : "identical", origin, result, sourceName };
}

export function useBundleIntake(targetId: string): BundleIntake {
  const uploadMutation = useUploadBundle();
  const pasteMutation = usePasteManifest();
  const attemptKeys = useAttemptKeys();
  const [outcome, setOutcome] = useState<IntakeOutcome | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);

  const isBusy = uploadMutation.isPending || pasteMutation.isPending;
  const busyOrigin: IntakeOrigin | null = uploadMutation.isPending
    ? "upload"
    : pasteMutation.isPending
      ? "paste"
      : null;

  async function settle(
    origin: IntakeOrigin,
    sourceName: string,
    run: () => Promise<BundleUploadResult>,
  ): Promise<IntakeOutcome> {
    setOutcome(null);
    setStartedAt(Date.now());
    let next: IntakeOutcome;
    try {
      const result = await run();
      attemptKeys.settle();
      next = successOutcome(origin, result, sourceName);
    } catch (error) {
      const failure = describeUploadFailure(error);
      if (failure.kind === "idempotency_conflict") {
        attemptKeys.settle();
      }
      next = { kind: "failed", origin, failure, sourceName };
    }
    setStartedAt(null);
    setOutcome(next);
    return next;
  }

  async function upload(file: File, note: string): Promise<IntakeOutcome | null> {
    if (isBusy) {
      return null;
    }
    const idempotencyKey = attemptKeys.keyFor(fileFingerprint(file, targetId, note));
    return settle("upload", file.name, () =>
      uploadMutation.mutateAsync({ file, targetId, note, idempotencyKey }),
    );
  }

  async function paste(manifestYaml: string, note: string): Promise<IntakeOutcome | null> {
    if (isBusy) {
      return null;
    }
    const idempotencyKey = attemptKeys.keyFor(textFingerprint(manifestYaml, targetId, note));
    return settle("paste", PASTE_SOURCE_NAME, () =>
      pasteMutation.mutateAsync({ manifestYaml, targetId, note, idempotencyKey }),
    );
  }

  return {
    isBusy,
    busyOrigin,
    startedAt,
    outcome,
    upload,
    paste,
    dismiss: () => setOutcome(null),
  };
}
