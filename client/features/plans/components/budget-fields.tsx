"use client";

import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatPlaceholder, type BudgetFieldErrors } from "../budget-input";
import type { Budget } from "../types";
import { OptionSection } from "./option-section";

export interface BudgetFieldsProps {
  maxUsd: string;
  maxMinutes: string;
  onMaxUsdChange: (value: string) => void;
  onMaxMinutesChange: (value: string) => void;
  placeholders: Budget | null;
  errors: BudgetFieldErrors;
  disabled?: boolean;
}

interface BudgetFieldProps {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  inputMode: "decimal" | "numeric";
  error: string | undefined;
  disabled: boolean;
  onChange: (value: string) => void;
}

function BudgetField({
  id,
  label,
  value,
  placeholder,
  inputMode,
  error,
  disabled,
  onChange,
}: BudgetFieldProps) {
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="font-normal">
        {label}
      </Label>
      <Input
        id={id}
        type="text"
        inputMode={inputMode}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : errorId}
        onChange={(event) => onChange(event.target.value)}
      />
      {error === undefined ? null : (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function BudgetFields({
  maxUsd,
  maxMinutes,
  onMaxUsdChange,
  onMaxMinutesChange,
  placeholders,
  errors,
  disabled = false,
}: BudgetFieldsProps) {
  const groupId = useId();

  return (
    <OptionSection
      title="Budget"
      description="Optional limits for this run. Leave both empty to use the server defaults shown in the boxes."
    >
      <div className="grid grid-cols-2 gap-3">
        <BudgetField
          id={`${groupId}-usd`}
          label="Max cost (USD)"
          value={maxUsd}
          placeholder={formatPlaceholder(placeholders?.max_usd)}
          inputMode="decimal"
          error={errors.max_usd}
          disabled={disabled}
          onChange={onMaxUsdChange}
        />
        <BudgetField
          id={`${groupId}-minutes`}
          label="Max time (minutes)"
          value={maxMinutes}
          placeholder={formatPlaceholder(placeholders?.max_minutes)}
          inputMode="numeric"
          error={errors.max_minutes}
          disabled={disabled}
          onChange={onMaxMinutesChange}
        />
      </div>
    </OptionSection>
  );
}
