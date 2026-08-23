"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useId } from "react";
import { Controller, useForm, useFormState, type UseFormReturn } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { catalogQuery } from "@/features/catalog/queries";
import { StartFormShell } from "@/features/runs/components/start-form-shell";
import { describeApiError } from "@/lib/api/errors";
import { applyApiFieldErrors } from "@/lib/api/form-errors";
import type { Budget } from "@/lib/api/types";
import { targetRoutes } from "@/lib/routes";
import { useStartExploration } from "../mutations";
import {
  defaultExplorationValues,
  EXPLORATION_FORM_FIELDS,
  explorationFormSchema,
  toExplorationCreate,
  type ExplorationFormValues,
} from "../schemas";
import { GoalPicker } from "./goal-picker";

export type ExploreFormProps = { targetId: string };

function RoleField({
  targetId,
  form,
}: {
  targetId: string;
  form: UseFormReturn<ExplorationFormValues>;
}) {
  const roleId = useId();
  const catalog = useQuery(catalogQuery({ targetId, bundleId: null, filters: {} }));
  const { errors } = useFormState({ control: form.control, name: "role" });

  if (catalog.isPending) {
    return (
      <div role="status" aria-busy="true">
        <span className="sr-only">Loading the roles</span>
        <Skeleton className="h-8 w-64" />
      </div>
    );
  }
  if (catalog.isError) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
        <span>The roles could not be loaded: {describeApiError(catalog.error)}</span>
        <Button type="button" size="sm" variant="outline" onClick={() => void catalog.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  const roles = catalog.data.roles;
  return (
    <Field data-invalid={errors.role ? true : undefined}>
      <FieldLabel htmlFor={roleId}>Role</FieldLabel>
      <Controller
        control={form.control}
        name="role"
        render={({ field }) => (
          <Select value={field.value} onValueChange={field.onChange}>
            <SelectTrigger
              id={roleId}
              className="w-full max-w-md"
              aria-invalid={errors.role ? true : undefined}
            >
              <SelectValue placeholder="Choose a role" />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              {roles.map((role) => (
                <SelectItem key={role.id} value={role.id}>
                  {role.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      />
      <FieldDescription>
        The explorer signs in as this role and only does what the role can do.
      </FieldDescription>
      <FieldError errors={[errors.role]} />
    </Field>
  );
}

function MaxStepsField({ form }: { form: UseFormReturn<ExplorationFormValues> }) {
  const stepsId = useId();
  const { errors } = useFormState({ control: form.control, name: "max_steps" });
  return (
    <Field data-invalid={errors.max_steps ? true : undefined}>
      <FieldLabel htmlFor={stepsId}>Max steps</FieldLabel>
      <Input
        id={stepsId}
        inputMode="numeric"
        autoComplete="off"
        placeholder="Server default"
        className="max-w-40"
        aria-invalid={errors.max_steps ? true : undefined}
        {...form.register("max_steps")}
      />
      <FieldDescription>
        Optional. The explorer stops after this many actions. Leave it empty for the server default.
      </FieldDescription>
      <FieldError errors={[errors.max_steps]} />
    </Field>
  );
}

function useNoBundle(targetId: string): boolean {
  const catalog = useQuery(catalogQuery({ targetId, bundleId: null, filters: {} }));
  return catalog.data !== undefined && catalog.data.bundle_id === null;
}

export function ExploreForm({ targetId }: ExploreFormProps) {
  const form = useForm<ExplorationFormValues>({
    resolver: zodResolver(explorationFormSchema),
    defaultValues: defaultExplorationValues(),
  });
  const start = useStartExploration();
  const noBundle = useNoBundle(targetId);

  function submit(budget: Budget): void {
    void form.handleSubmit((values) => {
      start.start(toExplorationCreate(values, targetId, budget), {
        onError: (error) => {
          applyApiFieldErrors(error, form.setError, EXPLORATION_FORM_FIELDS);
        },
      });
    })();
  }

  return (
    <StartFormShell
      targetId={targetId}
      action="explore.start"
      label="Start an exploration"
      submitLabel="Start exploring"
      pendingLabel="Starting"
      productionPolicy="read_only"
      isPending={start.isPending}
      error={start.error}
      canSubmit={!noBundle}
      incompleteReason={noBundle ? "This target has no valid bundle yet" : null}
      onSubmit={submit}
    >
      {noBundle ? (
        <p role="status" className="text-sm text-muted-foreground" data-slot="no-bundle">
          This target has no valid bundle, so there are no roles to explore as.{" "}
          <Link href={targetRoutes.bundles(targetId)} className="underline underline-offset-3">
            Upload a bundle
          </Link>
        </p>
      ) : (
        <FieldGroup>
          <RoleField targetId={targetId} form={form} />
          <GoalPicker targetId={targetId} form={form} />
          <MaxStepsField form={form} />
        </FieldGroup>
      )}
    </StartFormShell>
  );
}
