"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Mutant } from "../types";
import { MutantForm } from "./mutant-form";

export interface MutantFormDialogProps {
  targetId: string;
  mutant: Mutant | null;
  onClose: () => void;
}

export function MutantFormDialog({ targetId, mutant, onClose }: MutantFormDialogProps) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{mutant === null ? "Register a mutant" : "Edit mutant"}</DialogTitle>
          <DialogDescription>
            A mutant is a branch with one deliberate bug. Name the invariants that should catch it,
            and say where it is deployed once it runs on QA. The form comes from the published
            mutant schema and the server checks every value again.
          </DialogDescription>
        </DialogHeader>
        <MutantForm
          targetId={targetId}
          mutant={mutant ?? undefined}
          onDone={onClose}
          onCancel={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}
