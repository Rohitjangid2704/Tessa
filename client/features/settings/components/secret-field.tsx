"use client";

import { Check, CircleDashed } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";
import { DateTime } from "@/components/date-time";
import { StatusBadge } from "@/components/status/status-badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SecretStatus } from "@/lib/api/types";
import { describeSecretFailure } from "../errors";
import { useClearSecret, useSetSecret } from "../mutations";
import { validateSecretInput, type SecretDefinition } from "../schemas";

export interface SecretFieldProps {
  definition: SecretDefinition;
  status: SecretStatus | undefined;
  readOnly: boolean;
}

function SourceText({ status }: { status: SecretStatus | undefined }) {
  if (status?.has_value !== true) {
    return <>No key is set.</>;
  }
  if (status.source === "db") {
    return (
      <>
        Stored in Tessa, set <DateTime value={status.last_set_at} />.
      </>
    );
  }
  return (
    <>
      Provided by the deployment environment. Replacing it stores a key in Tessa that takes
      over.
    </>
  );
}

export function SecretField({ definition, status, readOnly }: SecretFieldProps) {
  const inputId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const setSecret = useSetSecret();
  const clearSecret = useClearSecret();
  const hasValue = status?.has_value === true;
  const busy = setSecret.isPending || clearSecret.isPending;

  function openEditor(): void {
    setError(null);
    setNotice(null);
    setEditing(true);
  }

  function closeEditor(): void {
    setError(null);
    setEditing(false);
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const input = inputRef.current;
    if (input === null) {
      return;
    }
    const typed = input.value;
    input.value = "";
    const problem = validateSecretInput(definition.name, typed);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setError(null);
    setSecret.mutate(
      { name: definition.name, value: typed },
      {
        onSuccess: () => {
          setEditing(false);
          setNotice(`${definition.label} saved. It is stored write-only and never shown again.`);
        },
        onError: (failure) => setError(describeSecretFailure(failure)),
        onSettled: () => setSecret.reset(),
      },
    );
  }

  function clear(): void {
    setError(null);
    setNotice(null);
    clearSecret.mutate(definition.name, {
      onSuccess: () => setNotice(`${definition.label} cleared.`),
      onError: (failure) => setError(describeSecretFailure(failure)),
      onSettled: () => clearSecret.reset(),
    });
  }

  return (
    <li
      data-secret={definition.name}
      data-has-value={hasValue ? "true" : "false"}
      className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm font-medium">{definition.label}</p>
          <p className="text-sm text-muted-foreground">{definition.description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {hasValue ? (
            <StatusBadge tone="verdict-pass" label="Set" icon={Check} />
          ) : (
            <StatusBadge tone="hollow" label="Not set" icon={CircleDashed} />
          )}
          {status?.source === undefined || status.source === null ? null : (
            <Badge variant={status.source === "db" ? "secondary" : "outline"}>
              {status.source === "db" ? "Stored in Tessa" : "From environment"}
            </Badge>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        <SourceText status={status} />
      </p>
      {editing ? (
        <form
          aria-label={`Key editor for ${definition.label}`}
          noValidate
          autoComplete="off"
          onSubmit={submit}
          className="flex flex-wrap items-start gap-2"
        >
          <div className="flex min-w-64 flex-1 flex-col gap-1">
            <Label htmlFor={inputId} className="sr-only">
              New value for {definition.label}
            </Label>
            <Input
              id={inputId}
              ref={inputRef}
              type="password"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              autoFocus
              disabled={setSecret.isPending}
              placeholder={setSecret.isPending ? "Saving" : "Paste the key"}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
            />
            <FieldError id={errorId} errors={[error ? { message: error } : undefined]} />
          </div>
          <Button type="submit" disabled={setSecret.isPending}>
            {setSecret.isPending ? "Saving" : "Save key"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={setSecret.isPending}
            onClick={closeEditor}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <>
          {readOnly ? null : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={openEditor}
              >
                {hasValue ? "Replace" : "Set key"}{" "}
                <span className="sr-only">{definition.label}</span>
              </Button>
              {status?.source === "db" ? (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button type="button" variant="ghost" size="sm" disabled={busy}>
                      Clear <span className="sr-only">{definition.label}</span>
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Clear the {definition.label}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Tessa deletes the key it stores. If the deployment environment also
                        provides one, that key is used again.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={clear}>Clear key</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : null}
              {clearSecret.isPending ? (
                <span className="text-xs text-muted-foreground">Clearing</span>
              ) : null}
            </div>
          )}
          {error ? <FieldError id={errorId}>{error}</FieldError> : null}
        </>
      )}
      <p role="status" className={notice ? "text-sm font-medium" : "sr-only"}>
        {notice}
      </p>
    </li>
  );
}
