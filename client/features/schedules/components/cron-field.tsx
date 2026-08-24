"use client";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { CRON_PRESETS, describeCron } from "../cron";

export interface CronFieldProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  timeZone: string;
  error?: string;
  disabled?: boolean;
}

export function CronField({
  id,
  value,
  onChange,
  timeZone,
  error,
  disabled = false,
}: CronFieldProps) {
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const reading = describeCron(value);
  const typed = value.trim() !== "";
  const describedBy = [descriptionId, error === undefined ? null : errorId]
    .filter((entry) => entry !== null)
    .join(" ");

  return (
    <Field data-slot="cron-field" data-invalid={error === undefined ? undefined : true}>
      <FieldLabel htmlFor={id}>Cron expression</FieldLabel>
      <Input
        id={id}
        name="cron"
        type="text"
        value={value}
        disabled={disabled}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder="0 2 * * *"
        className="font-mono"
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
      <FieldDescription id={descriptionId} aria-live="polite">
        {reading !== null
          ? `${reading}, in ${timeZone.trim() === "" ? "the schedule time zone" : timeZone.trim()}.`
          : typed
            ? "Could not read this as a cron expression. The server checks it when you save."
            : "Five fields: minute, hour, day of month, month, day of week."}
      </FieldDescription>
      {error === undefined ? null : <FieldError id={errorId}>{error}</FieldError>}
      <div role="group" aria-label="Cron presets" className="flex flex-wrap gap-2">
        {CRON_PRESETS.map((preset) => (
          <Button
            key={preset.id}
            type="button"
            variant="outline"
            size="xs"
            disabled={disabled}
            aria-pressed={value.trim() === preset.cron}
            onClick={() => onChange(preset.cron)}
          >
            {preset.label}
          </Button>
        ))}
      </div>
    </Field>
  );
}
