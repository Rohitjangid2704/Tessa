"use client";

import { Trash2 } from "lucide-react";
import { useState } from "react";
import { readRequestId } from "@/components/states/request-id";
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
import { Button } from "@/components/ui/button";
import { describeApiError } from "@/lib/api/errors";

export interface DeleteConfirmProps {
  triggerLabel: string;
  title: string;
  description: string;
  confirmLabel: string;
  isPending: boolean;
  error: unknown;
  onConfirm: (onDeleted: () => void) => void;
  onReset: () => void;
}

export function DeleteConfirm({
  triggerLabel,
  title,
  description,
  confirmLabel,
  isPending,
  error,
  onConfirm,
  onReset,
}: DeleteConfirmProps) {
  const [open, setOpen] = useState(false);
  const hasError = error !== null && error !== undefined;
  const requestId = readRequestId(error);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          onReset();
        }
      }}
    >
      <AlertDialogTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={triggerLabel}>
          <Trash2 aria-hidden="true" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {hasError ? (
          <p role="alert" className="text-sm text-destructive">
            {describeApiError(error)}
            {requestId === null ? null : ` Request ID: ${requestId}`}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Keep it</AlertDialogCancel>
          <AlertDialogAction
            disabled={isPending}
            onClick={(event) => {
              event.preventDefault();
              onConfirm(() => setOpen(false));
            }}
          >
            {isPending ? "Deleting" : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
