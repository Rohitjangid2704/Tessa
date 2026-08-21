"use client";

import { LoaderCircle } from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
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
import { cn } from "@/lib/utils";

export function isConfirmationMatch(typed: string, expected: string): boolean {
  return expected.length > 0 && typed === expected;
}

export interface TypedConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  expectedText: string;
  confirmLabel: string;
  onConfirm: (typed: string) => void;
  fieldLabel?: string;
  pendingLabel?: string;
  pending?: boolean;
  error?: string | null;
  onTypedChange?: (typed: string) => void;
  children?: ReactNode;
  className?: string;
}

type TypedConfirmFormProps = Omit<TypedConfirmDialogProps, "open" | "title" | "className">;

function TypedConfirmForm({
  onOpenChange,
  description,
  expectedText,
  confirmLabel,
  onConfirm,
  fieldLabel,
  pendingLabel,
  pending = false,
  error = null,
  onTypedChange,
  children,
  title,
}: TypedConfirmFormProps & { title: string }) {
  const fieldId = useId();
  const hintId = useId();
  const errorId = useId();
  const [typed, setTyped] = useState("");
  const matches = isConfirmationMatch(typed, expectedText);
  const hasError = error !== null && error !== "";

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (matches && !pending) {
      onConfirm(typed);
    }
  }

  return (
    <form
      noValidate
      onSubmit={handleSubmit}
      data-slot="typed-confirm-form"
      className="grid min-w-0 gap-4"
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription asChild>
          <div>{description}</div>
        </DialogDescription>
      </DialogHeader>
      {children}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={fieldId}>
          {fieldLabel ?? (
            <>
              Type <span className="font-mono font-semibold break-all">{expectedText}</span> to
              confirm
            </>
          )}
        </Label>
        <Input
          id={fieldId}
          value={typed}
          autoFocus
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          disabled={pending}
          aria-invalid={hasError}
          aria-describedby={hasError ? `${hintId} ${errorId}` : hintId}
          onChange={(event) => {
            setTyped(event.target.value);
            onTypedChange?.(event.target.value);
          }}
        />
        <p id={hintId} className="text-xs text-muted-foreground">
          The name must match exactly, including capital letters and spaces.
        </p>
        {hasError ? (
          <p id={errorId} role="alert" className="text-sm font-medium text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={!matches || pending} aria-busy={pending}>
          {pending ? (
            <LoaderCircle aria-hidden="true" data-icon="inline-start" className="animate-spin" />
          ) : null}
          {pending ? (pendingLabel ?? confirmLabel) : confirmLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function TypedConfirmDialog({
  open,
  onOpenChange,
  title,
  className,
  pending = false,
  ...form
}: TypedConfirmDialogProps) {
  function handleOpenChange(next: boolean): void {
    if (!next && pending) {
      return;
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className={cn("sm:max-w-xl", className)}>
        <TypedConfirmForm
          {...form}
          title={title}
          pending={pending}
          onOpenChange={handleOpenChange}
        />
      </DialogContent>
    </Dialog>
  );
}
