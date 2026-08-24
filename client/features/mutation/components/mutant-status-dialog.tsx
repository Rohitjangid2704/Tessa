"use client";

import { TriangleAlert } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { isApiError } from "@/lib/api/errors";
import { describeMutantError } from "../errors";
import { useUpdateMutant } from "../mutations";
import { MUTANT_STATUS_HELP, MUTANT_STATUS_LABELS, MUTANT_STATUSES } from "../schemas";
import type { Mutant, MutantStatus } from "../types";

const URL_PATTERN = /^https?:\/\/\S+$/;

export interface MutantStatusDialogProps {
  mutant: Mutant;
  onClose: () => void;
}

function isMutantStatus(value: string): value is MutantStatus {
  return MUTANT_STATUSES.some((status) => status === value);
}

function baseUrlProblem(status: MutantStatus, baseUrl: string): string | null {
  if (status !== "deployed") {
    return null;
  }
  const trimmed = baseUrl.trim();
  if (trimmed === "") {
    return "A deployed mutant needs the URL it is served from.";
  }
  return URL_PATTERN.test(trimmed) ? null : "Enter a URL that starts with http:// or https://.";
}

export function MutantStatusDialog({ mutant, onClose }: MutantStatusDialogProps) {
  const baseId = useId();
  const update = useUpdateMutant();
  const [status, setStatus] = useState<MutantStatus>(mutant.status);
  const [baseUrl, setBaseUrl] = useState(mutant.base_url ?? "");
  const [attempted, setAttempted] = useState(false);
  const [serverUrlError, setServerUrlError] = useState<string | null>(null);

  const urlId = `${baseId}-url`;
  const urlErrorId = `${urlId}-error`;
  const clientProblem = baseUrlProblem(status, baseUrl);
  const urlError = serverUrlError ?? (attempted ? clientProblem : null);
  const failure =
    update.error !== null && update.error !== undefined && serverUrlError === null
      ? update.error
      : null;
  const unchanged = status === mutant.status && (status !== "deployed" || baseUrl.trim() === (mutant.base_url ?? ""));

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setAttempted(true);
    if (clientProblem !== null || update.isPending) {
      return;
    }
    setServerUrlError(null);
    update.mutate(
      {
        mutantId: mutant.id,
        update: status === "deployed" ? { status, base_url: baseUrl.trim() } : { status },
      },
      {
        onSuccess: () => {
          toast.success(`${mutant.name} is now ${MUTANT_STATUS_LABELS[status].toLowerCase()}`);
          onClose();
        },
        onError: (error) => {
          if (isApiError(error) && error.status === 422) {
            const urlDetail = error.details.find((detail) => detail.loc.includes("base_url"));
            if (urlDetail !== undefined) {
              setServerUrlError(urlDetail.message);
            }
          }
        },
      },
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Deployment of {mutant.name}</DialogTitle>
          <DialogDescription>
            Tell Tessa where this mutant stands. Only a deployed mutant can be run.
          </DialogDescription>
        </DialogHeader>
        <form
          id={`${baseId}-form`}
          noValidate
          autoComplete="off"
          onSubmit={handleSubmit}
          aria-label={`Deployment of ${mutant.name}`}
          className="flex flex-col gap-4"
        >
          <RadioGroup
            value={status}
            onValueChange={(next) => {
              if (isMutantStatus(next)) {
                setStatus(next);
                setServerUrlError(null);
              }
            }}
            aria-label="Mutant status"
            disabled={update.isPending}
            className="flex flex-col gap-3"
          >
            {MUTANT_STATUSES.map((option) => {
              const optionId = `${baseId}-${option}`;
              return (
                <div key={option} className="flex items-start gap-2">
                  <RadioGroupItem value={option} id={optionId} className="mt-0.5" />
                  <Label htmlFor={optionId} className="flex flex-col items-start gap-0.5">
                    <span>{MUTANT_STATUS_LABELS[option]}</span>
                    <span className="text-xs font-normal text-muted-foreground">
                      {MUTANT_STATUS_HELP[option]}
                    </span>
                  </Label>
                </div>
              );
            })}
          </RadioGroup>
          {status === "deployed" ? (
            <Field data-invalid={urlError === null ? undefined : true}>
              <FieldLabel htmlFor={urlId}>Deployed at</FieldLabel>
              <Input
                id={urlId}
                value={baseUrl}
                disabled={update.isPending}
                placeholder="https://gracie-mutant-1.qa.example.test"
                autoComplete="off"
                spellCheck={false}
                aria-required
                aria-invalid={urlError === null ? undefined : true}
                aria-describedby={urlError === null ? undefined : urlErrorId}
                onChange={(event) => {
                  setBaseUrl(event.target.value);
                  setServerUrlError(null);
                }}
              />
              <FieldDescription>
                The QA address where this branch is running. A run can override it.
              </FieldDescription>
              {urlError === null ? null : <FieldError id={urlErrorId}>{urlError}</FieldError>}
            </Field>
          ) : null}
          {failure === null ? null : (
            <Alert variant="destructive">
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>Could not change the deployment</AlertTitle>
              <AlertDescription>
                <p>{describeMutantError(failure)}</p>
                {readRequestId(failure) === null ? null : (
                  <p className="font-mono text-xs">Request ID: {readRequestId(failure)}</p>
                )}
              </AlertDescription>
            </Alert>
          )}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={`${baseId}-form`}
            disabled={update.isPending || unchanged}
            aria-busy={update.isPending}
          >
            {update.isPending ? "Saving" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
