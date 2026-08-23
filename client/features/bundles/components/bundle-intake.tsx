"use client";

import { useId } from "react";
import { useCanDo } from "@/lib/auth/can";
import { useBundleIntake } from "../use-bundle-intake";
import { BundleDropZone } from "./bundle-drop-zone";
import { PasteManifestDialog } from "./paste-manifest-dialog";
import { UploadFailureAlert, UploadSuccess } from "./upload-result";
import { VersionList } from "./version-list";

export interface BundleIntakeProps {
  targetId: string;
}

export function BundleIntake({ targetId }: BundleIntakeProps) {
  const addHeadingId = useId();
  const versionsHeadingId = useId();
  const intake = useBundleIntake(targetId);
  const upload = useCanDo("bundles.upload");
  const readOnly = !upload.isPending && !upload.allowed;
  const outcome = intake.outcome;
  const success = outcome !== null && outcome.kind !== "failed" ? outcome : null;
  const failure =
    outcome !== null && outcome.kind === "failed" && outcome.origin === "upload" ? outcome : null;

  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby={addHeadingId} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id={addHeadingId} className="text-lg font-semibold">
            Add a version
          </h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Upload the zip of the tessa folder that Claude Code wrote, or paste its
            manifest.yaml. Validation, scoring and the diff run while you wait.
          </p>
        </div>
        {readOnly ? (
          <p
            data-slot="read-only-notice"
            className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground"
          >
            You have read-only access. Members and admins can add versions; you can still open any
            version below.
          </p>
        ) : (
          <>
            <BundleDropZone intake={intake} disabled={upload.isPending} />
            <div>
              <PasteManifestDialog intake={intake} disabled={upload.isPending} />
            </div>
          </>
        )}
        <div role="status">
          {success === null ? null : (
            <UploadSuccess outcome={success} targetId={targetId} onDismiss={intake.dismiss} />
          )}
        </div>
        {failure === null ? null : (
          <UploadFailureAlert
            failure={failure.failure}
            sourceName={failure.sourceName}
            onDismiss={intake.dismiss}
          />
        )}
      </section>
      <section aria-labelledby={versionsHeadingId} className="flex flex-col gap-4">
        <h2 id={versionsHeadingId} className="text-lg font-semibold">
          Versions
        </h2>
        <VersionList targetId={targetId} />
      </section>
    </div>
  );
}
