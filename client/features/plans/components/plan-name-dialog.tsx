"use client";

import { LoaderCircle } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { describeApiError } from "@/lib/api/errors";
import { planFieldErrorsFromApiError } from "../run-errors";
import { DEFAULT_PLAN_NAME_PLACEHOLDER, PLAN_NAME_MAX_LENGTH, planNameSchema } from "../schemas";

export interface PlanNameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  submitLabel: string;
  pendingLabel: string;
  initialName: string;
  isPending: boolean;
  error: unknown;
  onSubmit: (name: string) => void;
}

type PlanNameFormProps = Omit<PlanNameDialogProps, "open">;

function PlanNameForm({
  onOpenChange,
  title,
  description,
  submitLabel,
  pendingLabel,
  initialName,
  isPending,
  error,
  onSubmit,
}: PlanNameFormProps) {
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const [name, setName] = useState(initialName);
  const [localError, setLocalError] = useState<string | null>(null);
  const failed = error !== null && error !== undefined;
  const serverFieldError = planFieldErrorsFromApiError(error).name;
  const fieldMessage = localError ?? serverFieldError ?? null;
  const generalMessage = failed && serverFieldError === undefined ? describeApiError(error) : null;
  const requestId = failed ? readRequestId(error) : null;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const parsed = planNameSchema.safeParse(name);
    if (!parsed.success) {
      setLocalError(parsed.error.issues[0]?.message ?? "Give the plan a name");
      return;
    }
    setLocalError(null);
    onSubmit(parsed.data);
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={inputId}>Plan name</Label>
        <Input
          id={inputId}
          type="text"
          autoComplete="off"
          maxLength={PLAN_NAME_MAX_LENGTH}
          value={name}
          placeholder={DEFAULT_PLAN_NAME_PLACEHOLDER}
          aria-invalid={fieldMessage !== null}
          aria-describedby={fieldMessage === null ? undefined : errorId}
          onChange={(event) => setName(event.target.value)}
        />
        {fieldMessage === null ? null : (
          <p id={errorId} role="alert" className="text-xs text-destructive">
            {fieldMessage}
          </p>
        )}
      </div>
      {generalMessage === null ? null : (
        <Alert variant="destructive">
          <AlertDescription>
            <p>{generalMessage}</p>
            {requestId === null ? null : (
              <p className="mt-1 font-mono text-xs">Request ID: {requestId}</p>
            )}
          </AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={isPending} aria-busy={isPending}>
          {isPending ? (
            <LoaderCircle aria-hidden="true" data-icon="inline-start" className="animate-spin" />
          ) : null}
          {isPending ? pendingLabel : submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function PlanNameDialog({ open, onOpenChange, ...form }: PlanNameDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <PlanNameForm onOpenChange={onOpenChange} {...form} />
      </DialogContent>
    </Dialog>
  );
}
