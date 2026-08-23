"use client";

import { Check, CircleDashed, TriangleAlert } from "lucide-react";
import { Controller, useFormState, useWatch, type UseFormReturn } from "react-hook-form";
import { DateTime } from "@/components/date-time";
import { HealthTick } from "@/components/status/health-tick";
import { StatusBadge } from "@/components/status/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { AdapterEnvHints } from "@/features/adapters/components/adapter-env-hints";
import { distinctAdapterKinds } from "@/features/adapters/registry";
import { ENV_KIND_LABELS, KIND_HINTS, usesSwitch, type EnvironmentFormValues } from "../schemas";
import type { AdapterKind, EnvironmentVariable } from "../types";

export interface EnvVariableFieldProps {
  variable: EnvironmentVariable;
  form: UseFormReturn<EnvironmentFormValues>;
  interfaceKinds?: ReadonlyMap<string, AdapterKind>;
  readOnly: boolean;
  isSaving: boolean;
  serverError?: string;
}

function placeholderFor(variable: EnvironmentVariable): string {
  if (variable.secret) {
    return variable.has_value ? "Value is set. Type to replace it." : "Not set";
  }
  return variable.has_value ? "" : KIND_HINTS[variable.kind];
}

function inputType(variable: EnvironmentVariable): "password" | "url" | "text" {
  if (variable.secret) {
    return "password";
  }
  return variable.kind === "url" ? "url" : "text";
}

function describeSwitch(typed: string, cleared: boolean): string {
  if (cleared) {
    return "Will be cleared when you save";
  }
  if (typed === "") {
    return "Not set, turn it on or off to set it";
  }
  return typed === "true" ? "On (true)" : "Off (false)";
}

function StateBadges({ variable }: { variable: EnvironmentVariable }) {
  const missing = variable.required && !variable.stale;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant="outline">{variable.required ? "Required" : "Optional"}</Badge>
      <Badge variant="outline">{ENV_KIND_LABELS[variable.kind]}</Badge>
      {variable.secret ? <Badge variant="secondary">Secret</Badge> : null}
      {variable.has_value ? (
        <StatusBadge tone="verdict-pass" label="Set" icon={Check} />
      ) : (
        <StatusBadge
          tone={missing ? "verdict-flaky" : "hollow"}
          label="Not set"
          icon={missing ? TriangleAlert : CircleDashed}
        />
      )}
      {variable.stale ? (
        <StatusBadge tone="verdict-uncertain" label="Stale" icon={TriangleAlert} />
      ) : null}
    </div>
  );
}

export function EnvVariableField({
  variable,
  form,
  interfaceKinds,
  readOnly,
  isSaving,
  serverError,
}: EnvVariableFieldProps) {
  const { control, setValue } = form;
  const inputId = `env-${variable.name}`;
  const descriptionId = `${inputId}-description`;
  const adapterHintsId = `${inputId}-adapter-hints`;
  const adapterKinds = distinctAdapterKinds(variable.interface_ids, interfaceKinds);
  const describedBy =
    adapterKinds.length > 0 ? `${descriptionId} ${adapterHintsId}` : descriptionId;
  const valueName = `values.${variable.name}` as const;
  const clearName = `clear.${variable.name}` as const;
  const cleared = useWatch({ control, name: clearName }) === true;
  const { errors } = useFormState({ control, name: valueName });
  const message = errors.values?.[variable.name]?.message ?? serverError;
  const defaultText = variable.secret ? "" : (variable.value ?? "");

  function clearStoredValue(): void {
    setValue(valueName, "", { shouldDirty: true, shouldValidate: true });
    setValue(clearName, true, { shouldDirty: true, shouldValidate: true });
  }

  function keepStoredValue(): void {
    setValue(valueName, defaultText, { shouldDirty: true, shouldValidate: true });
    setValue(clearName, false, { shouldDirty: true, shouldValidate: true });
  }

  return (
    <Field
      data-slot="env-variable-field"
      data-variable={variable.name}
      data-stale={variable.stale ? "true" : undefined}
      data-invalid={message ? true : undefined}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <FieldLabel htmlFor={inputId} className="font-mono break-all">
          {variable.name}
        </FieldLabel>
        <StateBadges variable={variable} />
      </div>
      <FieldDescription id={descriptionId}>
        {variable.purpose === "" ? "No purpose given in the bundle." : variable.purpose}
        {variable.interface_ids.length > 0 ? (
          <>
            {" "}
            Used by <span className="font-mono">{variable.interface_ids.join(", ")}</span>.
          </>
        ) : null}
        {variable.stale ? " The latest bundle no longer declares it." : null}
      </FieldDescription>
      <AdapterEnvHints id={adapterHintsId} kinds={adapterKinds} />
      <Controller
        control={control}
        name={valueName}
        render={({ field }) =>
          usesSwitch(variable) ? (
            <div className="flex items-center gap-3">
              <Switch
                id={inputId}
                name={field.name}
                checked={field.value === "true"}
                disabled={readOnly || isSaving || cleared}
                aria-describedby={describedBy}
                onCheckedChange={(on) => field.onChange(on ? "true" : "false")}
              />
              <span className="text-sm text-muted-foreground">
                {describeSwitch(field.value ?? "", cleared)}
              </span>
            </div>
          ) : (
            <Input
              id={inputId}
              name={field.name}
              ref={field.ref}
              type={inputType(variable)}
              inputMode={variable.kind === "number" ? "decimal" : undefined}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              readOnly={readOnly}
              disabled={isSaving || cleared}
              value={cleared ? "" : (field.value ?? "")}
              placeholder={cleared ? "Will be cleared when you save" : placeholderFor(variable)}
              aria-invalid={message ? true : undefined}
              aria-describedby={describedBy}
              onBlur={field.onBlur}
              onChange={(event) => field.onChange(event.target.value)}
            />
          )
        }
      />
      <FieldError errors={[message ? { message } : undefined]} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {variable.health.status === "unchecked" ? null : (
          <span className="flex items-center gap-1.5">
            <HealthTick status={variable.health.status} />
            {variable.health.message ?? null}
          </span>
        )}
        {variable.last_set_at === null ? null : (
          <span>
            Last set <DateTime value={variable.last_set_at} />
          </span>
        )}
        {variable.has_value && !readOnly && !isSaving ? (
          cleared ? (
            <Button type="button" variant="ghost" size="xs" onClick={keepStoredValue}>
              Keep value <span className="sr-only">of {variable.name}</span>
            </Button>
          ) : (
            <Button type="button" variant="ghost" size="xs" onClick={clearStoredValue}>
              Clear <span className="sr-only">stored value of {variable.name}</span>
            </Button>
          )
        ) : null}
      </div>
    </Field>
  );
}
