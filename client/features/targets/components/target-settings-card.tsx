"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useForm, useFormState } from "react-hook-form";
import { toast } from "sonner";
import { RoleGate } from "@/components/role-gate";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { describeApiError, isApiError } from "@/lib/api/errors";
import { applyApiFieldErrors } from "@/lib/api/form-errors";
import { useUpdateTarget } from "../mutations";
import { TARGET_NAME_MAX_LENGTH, targetRenameSchema, type TargetRenameInput } from "../schemas";
import type { Target } from "../types";
import { JevConsent } from "./jev-consent";
import { TargetTeamField } from "./target-team-field";

export function describeUpdateError(error: unknown): string {
  if (isApiError(error) && error.status === 409) {
    return "This target is archived, so it cannot be edited.";
  }
  if (isApiError(error) && error.status === 403) {
    return "Your role cannot change this setting.";
  }
  return describeApiError(error);
}

function RenameForm({ target }: { target: Target }) {
  const update = useUpdateTarget(target.id);
  const form = useForm<TargetRenameInput>({
    resolver: zodResolver(targetRenameSchema),
    values: { name: target.name },
  });
  const { errors, isDirty } = useFormState({ control: form.control });
  const [formError, setFormError] = useState<string | null>(null);
  const archived = target.archived_at != null;

  function submit(values: TargetRenameInput): void {
    setFormError(null);
    update.mutate(
      { name: values.name },
      {
        onSuccess: () => toast.success("Target renamed"),
        onError: (error) => {
          const message = applyApiFieldErrors(error, form.setError, ["name"]);
          const validationFailure = isApiError(error) && error.status === 422;
          setFormError(
            message === null || validationFailure ? message : describeUpdateError(error),
          );
        },
      },
    );
  }

  return (
    <form aria-label="Rename target" noValidate onSubmit={form.handleSubmit(submit)}>
      <FieldGroup>
        {formError !== null ? (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}
        <Field data-invalid={errors.name ? true : undefined}>
          <FieldLabel htmlFor="target-rename">Name</FieldLabel>
          <Input
            id="target-rename"
            autoComplete="off"
            disabled={archived}
            aria-invalid={errors.name ? true : undefined}
            {...form.register("name")}
          />
          <FieldDescription>Up to {TARGET_NAME_MAX_LENGTH} characters.</FieldDescription>
          <FieldError errors={[errors.name]} />
        </Field>
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={archived || !isDirty || update.isPending}>
            {update.isPending ? "Saving" : "Save name"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!isDirty || update.isPending}
            onClick={() => {
              form.reset();
              setFormError(null);
            }}
          >
            Cancel
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

function AllowProductionControl({ target }: { target: Target }) {
  const update = useUpdateTarget(target.id);
  const archived = target.archived_at != null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <Switch
          id="allow-production"
          checked={target.allow_production}
          disabled={archived || update.isPending}
          onCheckedChange={(checked) => update.mutate({ allow_production: checked })}
        />
        <Label htmlFor="allow-production" className="font-normal">
          Allow runs against this target while it is production
        </Label>
      </div>
      <p className="text-sm text-muted-foreground">
        Runs on a production target stay read-only and need this switch. It has no effect on QA
        targets.
      </p>
      {update.isError ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription>{describeUpdateError(update.error)}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

export function TargetSettingsCard({ target }: { target: Target }) {
  return (
    <Card data-slot="target-settings-card">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Settings
        </CardTitle>
        <CardDescription>Rename the target. Admins also control production runs.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <RoleGate
          action="targets.update"
          fallback={
            <p className="text-sm text-muted-foreground">
              You can read this target. Renaming it needs the member or admin role.
            </p>
          }
        >
          <RenameForm target={target} />
        </RoleGate>
        <RoleGate action="targets.allow_production">
          <AllowProductionControl target={target} />
        </RoleGate>
        <JevConsent target={target} />
        <TargetTeamField target={target} />
      </CardContent>
    </Card>
  );
}
