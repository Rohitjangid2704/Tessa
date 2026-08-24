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
import { formatUsd } from "@/lib/format-usd";
import { describeTeamFailure } from "../labels";
import { useSetTeamBudget } from "../mutations";
import { budgetFormSchema, budgetFromInput, budgetToInput, type BudgetFormInput } from "../schemas";
import { SpendBar } from "./spend-bar";

export type BudgetEditorProps = {
  team: Team;
  onClose: () => void;
};

export function BudgetEditor({ team, onClose }: BudgetEditorProps) {
  const formId = useId();
  const budgetId = useId();
  const setBudget = useSetTeamBudget();
  const form = useForm<BudgetFormInput>({
    resolver: zodResolver(budgetFormSchema),
    defaultValues: { max_usd_month: budgetToInput(team.max_usd_month) },
  });
  const { errors, isDirty } = useFormState({ control: form.control });
  const [formError, setFormError] = useState<string | null>(null);

  function submit(values: BudgetFormInput): void {
    setFormError(null);
    setBudget.mutate(
      { teamId: team.id, maxUsdMonth: budgetFromInput(values) },
      {
        onSuccess: (saved) => {
          toast.success(
            `Budget for ${team.name} set to ${formatUsd(saved.max_usd_month)} a month`,
          );
          onClose();
        },
        onError: (error) => {
          const message = applyApiFieldErrors(error, form.setError, ["max_usd_month"]);
          const validationFailure = isApiError(error) && error.status === 422;
          setFormError(
            message === null || validationFailure ? message : describeTeamFailure("budget", error),
          );
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Budget for {team.name}</DialogTitle>
          <DialogDescription>
            A run for any of this team&apos;s targets is refused when it would take the team past
            the monthly budget.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium">Current</p>
          <SpendBar team={team} />
        </div>
        <form
          id={formId}
          aria-label={`Monthly budget for ${team.name}`}
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
            <Field data-invalid={errors.max_usd_month ? true : undefined}>
              <FieldLabel htmlFor={budgetId}>Monthly budget (USD)</FieldLabel>
              <Input
                id={budgetId}
                inputMode="decimal"
                autoComplete="off"
                aria-invalid={errors.max_usd_month ? true : undefined}
                {...form.register("max_usd_month")}
              />
              <FieldDescription>
                Whole dollars or cents, for example 150 or 99.50. The spend counter restarts each
                month.
              </FieldDescription>
              <FieldError errors={[errors.max_usd_month]} />
            </Field>
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={setBudget.isPending || !isDirty}>
            {setBudget.isPending ? "Saving" : "Save budget"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
