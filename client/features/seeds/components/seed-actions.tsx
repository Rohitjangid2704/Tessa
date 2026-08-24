"use client";

import { RotateCcw, ShieldCheck } from "lucide-react";
import { useId, useState } from "react";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useAttemptKeys } from "@/features/bundles/use-attempt-keys";
import type { Target } from "@/features/targets/types";
import { describeApiError } from "@/lib/api/errors";
import { useCanDo } from "@/lib/auth/can";
import { seedActionGate, type SeedGate } from "../gates";
import { useVerifySeed } from "../mutations";
import type { Seed } from "../types";
import { ResetSeedDialog } from "./reset-seed-dialog";

export interface SeedActionsProps {
  seed: Seed;
  target: Pick<Target, "id" | "name" | "tier" | "archived_at">;
  runActive: boolean;
  onRunStarted: (runId: string) => void;
}

function reasonOf(gate: SeedGate): string | null {
  return gate.allowed ? null : gate.reason;
}

export function SeedActions({ seed, target, runActive, onRunStarted }: SeedActionsProps) {
  const verifyAccess = useCanDo("seeds.verify");
  const resetAccess = useCanDo("seeds.reset");
  const verify = useVerifySeed(target.id);
  const keys = useAttemptKeys();
  const [resetOpen, setResetOpen] = useState(false);
  const verifyReasonId = useId();
  const resetReasonId = useId();
  const accessKnown = !verifyAccess.isPending && !resetAccess.isPending;

  if (accessKnown && !verifyAccess.allowed && !resetAccess.allowed) {
    return (
      <p data-slot="seed-viewer-note" className="text-sm text-muted-foreground">
        Your role is viewer, so verify and reset are hidden. A member can run them.
      </p>
    );
  }

  const gateInput = {
    seed,
    production: target.tier === "production",
    archived: target.archived_at != null,
    runActive,
  };
  const verifyReason =
    verifyAccess.reason ?? reasonOf(seedActionGate({ ...gateInput, action: "verify" }));
  const resetReason =
    resetAccess.reason ?? reasonOf(seedActionGate({ ...gateInput, action: "reset" }));
  const sharedReason = verifyReason !== null && verifyReason === resetReason;
  const resetDescribedBy = sharedReason ? verifyReasonId : resetReasonId;

  function startVerify(): void {
    verify.mutate(
      { seedId: seed.id, idempotencyKey: keys.keyFor(`verify|${seed.id}`) },
      {
        onSuccess: (handle) => {
          keys.settle();
          onRunStarted(handle.run_id);
        },
      },
    );
  }

  return (
    <div data-slot="seed-actions" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={verifyAccess.isPending || verifyReason !== null || verify.isPending}
          aria-describedby={verifyReason === null ? undefined : verifyReasonId}
          onClick={startVerify}
        >
          <ShieldCheck aria-hidden="true" data-icon="inline-start" />
          {verify.isPending ? "Starting verify" : "Verify"}
        </Button>
        <Button
          type="button"
          disabled={resetAccess.isPending || resetReason !== null}
          aria-describedby={resetReason === null ? undefined : resetDescribedBy}
          onClick={() => setResetOpen(true)}
        >
          <RotateCcw aria-hidden="true" data-icon="inline-start" />
          Reset
        </Button>
      </div>
      {verifyReason === null ? null : (
        <p id={verifyReasonId} data-slot="verify-reason" className="text-sm text-muted-foreground">
          {sharedReason ? null : <span className="font-medium text-foreground">Verify: </span>}
          {verifyReason}
        </p>
      )}
      {resetReason === null || sharedReason ? null : (
        <p id={resetReasonId} data-slot="reset-reason" className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Reset: </span>
          {resetReason}
        </p>
      )}
      {verify.isError ? (
        <Alert variant="destructive" data-slot="verify-error">
          <AlertTitle>Could not start the verification</AlertTitle>
          <AlertDescription>
            {describeApiError(verify.error)}
            {readRequestId(verify.error) === null
              ? null
              : ` Request ID: ${readRequestId(verify.error)}`}
          </AlertDescription>
        </Alert>
      ) : null}
      <ResetSeedDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        seed={seed}
        target={target}
        onRunStarted={onRunStarted}
      />
    </div>
  );
}
