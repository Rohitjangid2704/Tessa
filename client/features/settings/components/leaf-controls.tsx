"use client";

import { RotateCcw } from "lucide-react";
import { Controller, useFormState, useWatch } from "react-hook-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SettingSource } from "@/lib/api/types";
import { EFFORTS, isOverridden, type LeafSpec } from "../schemas";
import type { SectionApi } from "./settings-section";

export function SourceBadge({ source }: { source: SettingSource }) {
  return (
    <Badge
      variant={source === "db" ? "secondary" : "outline"}
      data-slot="source-badge"
      data-source={source}
    >
      {source === "db" ? "DB override" : "Env default"}
    </Badge>
  );
}

export function leafInputId(spec: LeafSpec): string {
  return `setting-${spec.id}`;
}

export function leafErrorId(spec: LeafSpec): string {
  return `${leafInputId(spec)}-error`;
}

function inputModeOf(spec: LeafSpec): "decimal" | "numeric" | "url" | "text" {
  switch (spec.kind) {
    case "positive-number":
    case "unit-interval":
      return "decimal";
    case "positive-integer":
      return "numeric";
    case "url":
    case "optional-url":
      return "url";
    default:
      return "text";
  }
}

export interface LeafControlProps {
  api: SectionApi;
  spec: LeafSpec;
  label?: string;
  describedBy?: string;
}

export function LeafControl({ api, spec, label, describedBy }: LeafControlProps) {
  const { control } = api.form;
  const valueName = `values.${spec.id}` as const;
  const resetName = `reset.${spec.id}` as const;
  const staged = useWatch({ control, name: resetName }) === true;
  const { errors } = useFormState({ control, name: valueName });
  const message = errors.values?.[spec.id]?.message ?? api.serverError(spec.id);
  const disabled = api.isSaving || staged;
  const describedByIds = [message ? leafErrorId(spec) : null, describedBy]
    .filter((id): id is string => id !== null && id !== undefined)
    .join(" ");

  return (
    <Controller
      control={control}
      name={valueName}
      render={({ field }) =>
        spec.kind === "effort" ? (
          <Select
            value={staged ? "" : (field.value ?? "")}
            onValueChange={field.onChange}
            disabled={api.readOnly || disabled}
          >
            <SelectTrigger
              id={leafInputId(spec)}
              aria-label={label}
              aria-invalid={message ? true : undefined}
              aria-describedby={describedByIds === "" ? undefined : describedByIds}
              className="w-full min-w-28"
            >
              <SelectValue placeholder={staged ? "Default" : "Choose an effort"} />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              {EFFORTS.map((effort) => (
                <SelectItem key={effort} value={effort}>
                  {effort}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            id={leafInputId(spec)}
            name={field.name}
            ref={field.ref}
            type="text"
            inputMode={inputModeOf(spec)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-label={label}
            readOnly={api.readOnly}
            disabled={disabled}
            value={staged ? "" : (field.value ?? "")}
            placeholder={staged ? "Default on save" : undefined}
            aria-invalid={message ? true : undefined}
            aria-describedby={describedByIds === "" ? undefined : describedByIds}
            onBlur={field.onBlur}
            onChange={(event) => field.onChange(event.target.value)}
          />
        )
      }
    />
  );
}

export function LeafMessage({ api, spec }: { api: SectionApi; spec: LeafSpec }) {
  const { errors } = useFormState({ control: api.form.control, name: `values.${spec.id}` });
  const message = errors.values?.[spec.id]?.message ?? api.serverError(spec.id);
  return <FieldError id={leafErrorId(spec)} errors={[message ? { message } : undefined]} />;
}

export interface LeafResetProps {
  api: SectionApi;
  spec: LeafSpec;
  compact?: boolean;
}

export function LeafReset({ api, spec, compact = false }: LeafResetProps) {
  const { control, setValue, trigger } = api.form;
  const resetName = `reset.${spec.id}` as const;
  const staged = useWatch({ control, name: resetName }) === true;
  if (api.readOnly || api.isSaving || !isOverridden(api.settings, spec)) {
    return null;
  }

  function changeStaged(next: boolean): void {
    setValue(resetName, next, { shouldDirty: true });
    void trigger(`values.${spec.id}`);
  }

  if (staged) {
    return (
      <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        Default on save
        <Button type="button" variant="ghost" size="xs" onClick={() => changeStaged(false)}>
          Keep override <span className="sr-only">for {spec.label}</span>
        </Button>
      </span>
    );
  }
  if (compact) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Reset to default for ${spec.label}`}
        title="Reset to default"
        onClick={() => changeStaged(true)}
      >
        <RotateCcw aria-hidden="true" />
      </Button>
    );
  }
  return (
    <Button type="button" variant="ghost" size="xs" onClick={() => changeStaged(true)}>
      <RotateCcw aria-hidden="true" />
      Reset to default <span className="sr-only">for {spec.label}</span>
    </Button>
  );
}

export interface LeafFieldProps {
  api: SectionApi;
  spec: LeafSpec;
  description: string;
}

export function LeafField({ api, spec, description }: LeafFieldProps) {
  const descriptionId = `${leafInputId(spec)}-description`;
  return (
    <Field data-leaf={spec.dotted}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <FieldLabel htmlFor={leafInputId(spec)}>{spec.label}</FieldLabel>
        <SourceBadge source={isOverridden(api.settings, spec) ? "db" : "env"} />
      </div>
      <FieldDescription id={descriptionId}>{description}</FieldDescription>
      <LeafControl api={api} spec={spec} describedBy={descriptionId} />
      <LeafMessage api={api} spec={spec} />
      {api.readOnly || api.isSaving || !isOverridden(api.settings, spec) ? null : (
        <div className="flex">
          <LeafReset api={api} spec={spec} />
        </div>
      )}
    </Field>
  );
}
