"use client";

import { TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { RoleGate } from "@/components/role-gate";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { describeApiError, isApiError } from "@/lib/api/errors";
import { useSetAllowJev } from "../jev-mutations";
import { allowsJev } from "../target-jev";
import type { Target } from "../types";

export function describeJevConsentError(error: unknown): string {
  if (isApiError(error) && error.status === 403) {
    return "Only an admin can change the Jev second-opinion setting.";
  }
  if (isApiError(error) && error.status === 409) {
    return "This target is archived, so it cannot be edited.";
  }
  return describeApiError(error);
}

function JevConsentDialog({
  target,
  open,
  onOpenChange,
  onConfirm,
}: {
  target: Target;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Allow Jev second opinions for {target.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            When a Laya probe is uncertain, Tessa can ask the hosted Jev model before it falls
            back to the judge.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-muted-foreground">
          <li>
            Text from this target&apos;s steps leaves your premises. It is scrubbed and size-capped
            first, but it can still contain what the app showed or said.
          </li>
          <li>
            A call also needs the deployment switch{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
              TESSA_JEV_ENABLED
            </code>
            . While that switch is off, this opt-in changes nothing.
          </li>
          <li>You can turn it off again at any time. Both changes go to the audit log.</li>
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Allow Jev</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function JevConsentControl({ target }: { target: Target }) {
  const switchId = useId();
  const descriptionId = useId();
  const update = useSetAllowJev(target.id);
  const [confirming, setConfirming] = useState(false);
  const allowed = allowsJev(target);
  const archived = target.archived_at != null;

  function save(next: boolean): void {
    update.mutate(next, {
      onSuccess: () =>
        toast.success(
          next
            ? "Jev second opinions allowed for this target"
            : "Jev second opinions turned off for this target",
        ),
    });
  }

  return (
    <div data-slot="jev-consent" className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <Switch
          id={switchId}
          checked={allowed}
          disabled={archived || update.isPending}
          aria-describedby={descriptionId}
          onCheckedChange={(checked) => (checked ? setConfirming(true) : save(false))}
        />
        <Label htmlFor={switchId} className="font-normal">
          Allow Jev second opinions on uncertain probes
        </Label>
      </div>
      <p id={descriptionId} className="text-sm text-muted-foreground">
        Off by default. Turning it on lets text from this target leave your premises when a Laya
        probe is uncertain, and only while the deployment has Jev enabled.
      </p>
      {update.isError ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription>{describeJevConsentError(update.error)}</AlertDescription>
        </Alert>
      ) : null}
      <JevConsentDialog
        target={target}
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={() => save(true)}
      />
    </div>
  );
}

export function JevConsent({ target }: { target: Target }) {
  return (
    <RoleGate
      action="jev.consent"
      fallback={
        <p data-slot="jev-consent" className="text-sm text-muted-foreground">
          Jev second opinions are {allowsJev(target) ? "allowed" : "off"} for this target. Changing
          that needs the admin role.
        </p>
      }
    >
      <JevConsentControl target={target} />
    </RoleGate>
  );
}
