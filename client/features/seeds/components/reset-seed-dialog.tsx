"use client";

import { TriangleAlert } from "lucide-react";
import { readRequestId } from "@/components/states/request-id";
import { TypedConfirmDialog } from "@/components/typed-confirm-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useAttemptKeys } from "@/features/bundles/use-attempt-keys";
import { describeApiError, isApiError } from "@/lib/api/errors";
import { useResetSeed } from "../mutations";
import { CONFIRMATION_MISMATCH_CODE, seedResetSchema } from "../schemas";
import type { Seed } from "../types";
import { ScriptPreview } from "./script-preview";

export interface ResetSeedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seed: Seed;
  target: { id: string; name: string };
  onRunStarted: (runId: string) => void;
}

export function confirmationMismatchMessage(error: unknown): string | null {
  if (!isApiError(error) || error.code !== CONFIRMATION_MISMATCH_CODE) {
    return null;
  }
  const detail = error.details.find((entry) => entry.loc.includes("confirm_target_name"));
  return detail?.message ?? error.message;
}

export function ResetSeedDialog({
  open,
  onOpenChange,
  seed,
  target,
  onRunStarted,
}: ResetSeedDialogProps) {
  const reset = useResetSeed(target.id);
  const keys = useAttemptKeys();
  const fieldError = confirmationMismatchMessage(reset.error);
  const otherError = reset.isError && fieldError === null ? reset.error : null;

  function handleOpenChange(next: boolean): void {
    if (!next) {
      reset.reset();
    }
    onOpenChange(next);
  }

  function handleConfirm(typed: string): void {
    const parsed = seedResetSchema(target.name).safeParse({ confirm_target_name: typed });
    if (!parsed.success) {
      return;
    }
    const confirmTargetName = parsed.data.confirm_target_name;
    reset.mutate(
      {
        seedId: seed.id,
        confirmTargetName,
        idempotencyKey: keys.keyFor(`reset|${seed.id}|${confirmTargetName}`),
      },
      {
        onSuccess: (handle) => {
          keys.settle();
          handleOpenChange(false);
          onRunStarted(handle.run_id);
        },
      },
    );
  }

  return (
    <TypedConfirmDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={`Reset ${target.name} to seed version ${seed.version}`}
      description={
        <p>
          The reset script below runs against the data of <strong>{target.name}</strong> and
          replaces what is there. Read it first. The hash command then runs and its result is
          compared with the declared hash.
        </p>
      }
      expectedText={target.name}
      confirmLabel="Reset seed"
      pendingLabel="Starting reset"
      pending={reset.isPending}
      error={fieldError}
      onTypedChange={() => {
        if (reset.isError) {
          reset.reset();
        }
      }}
      onConfirm={handleConfirm}
    >
      <div className="flex min-w-0 flex-col gap-3">
        <ScriptPreview seed={seed} variant="plain" />
        {otherError === null ? null : (
          <Alert variant="destructive" data-slot="reset-error">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>The reset did not start</AlertTitle>
            <AlertDescription>
              {describeApiError(otherError)}
              {readRequestId(otherError) === null
                ? null
                : ` Request ID: ${readRequestId(otherError)}`}
            </AlertDescription>
          </Alert>
        )}
      </div>
    </TypedConfirmDialog>
  );
}
