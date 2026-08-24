"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { useForm, useFormState } from "react-hook-form";
import { toast } from "sonner";
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { isApiError } from "@/lib/api/errors";
import { applyApiFieldErrors } from "@/lib/api/form-errors";
import type { Team } from "@/lib/api/types";
import { describeTeamFailure } from "../labels";
import { useCreateTeam, useRenameTeam } from "../mutations";
import { TEAM_NAME_MAX_LENGTH, teamFormSchema, type TeamFormInput } from "../schemas";

export type TeamFormDialogProps = {
  team: Team | null;
  onClose: () => void;
};

export function TeamFormDialog({ team, onClose }: TeamFormDialogProps) {
  const formId = useId();
  const nameId = useId();
  const creating = team === null;
  const create = useCreateTeam();
  const rename = useRenameTeam();
  const isSaving = create.isPending || rename.isPending;
  const form = useForm<TeamFormInput>({
    resolver: zodResolver(teamFormSchema),
    defaultValues: { name: team?.name ?? "" },
  });
  const { errors, isDirty } = useFormState({ control: form.control });
  const [formError, setFormError] = useState<string | null>(null);

  function reportFailure(error: unknown): void {
    const action = creating ? "create" : "rename";
    if (isApiError(error) && error.status === 409) {
      form.setError("name", { type: "server", message: describeTeamFailure(action, error) });
      setFormError(null);
      return;
    }
    const message = applyApiFieldErrors(error, form.setError, ["name"]);
    const validationFailure = isApiError(error) && error.status === 422;
    setFormError(
      message === null || validationFailure ? message : describeTeamFailure(action, error),
    );
  }

  function submit(values: TeamFormInput): void {
    setFormError(null);
    if (team === null) {
      create.create(
        { name: values.name },
        {
          onSuccess: (created) => {
            toast.success(`Team ${created.name} created`);
            onClose();
          },
          onError: reportFailure,
        },
      );
      return;
    }
    rename.mutate(
      { teamId: team.id, name: values.name },
      {
        onSuccess: (renamed) => {
          toast.success(`Team renamed to ${renamed.name}`);
          onClose();
        },
        onError: reportFailure,
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{team === null ? "New team" : `Rename ${team.name}`}</DialogTitle>
          <DialogDescription>
            A team groups targets under one monthly budget. It never limits who can see data.
          </DialogDescription>
        </DialogHeader>
        <form
          id={formId}
          aria-label={creating ? "New team" : "Rename team"}
          noValidate
          onSubmit={form.handleSubmit(submit)}
        >
          <FieldGroup>
            {formError !== null ? (
              <Alert variant="destructive">
                <TriangleAlert aria-hidden="true" />
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            ) : null}
            <Field data-invalid={errors.name ? true : undefined}>
              <FieldLabel htmlFor={nameId}>Team name</FieldLabel>
              <Input
                id={nameId}
                autoComplete="off"
                aria-invalid={errors.name ? true : undefined}
                {...form.register("name")}
              />
              <FieldDescription>
                Up to {TEAM_NAME_MAX_LENGTH} characters. Names are unique.
              </FieldDescription>
              <FieldError errors={[errors.name]} />
            </Field>
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={isSaving || (!creating && !isDirty)}>
            {isSaving ? "Saving" : creating ? "Create team" : "Save name"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
