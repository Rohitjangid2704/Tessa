"use client";

import { useId } from "react";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { Depth } from "../types";
import { OptionSection } from "./option-section";

export interface DepthPickerProps {
  value: Depth;
  onChange: (depth: Depth) => void;
  error?: string;
  disabled?: boolean;
}

interface DepthOption {
  value: Depth;
  label: string;
  hint: string;
  unavailableReason: string | null;
}

const DEPTH_OPTIONS: readonly DepthOption[] = [
  {
    value: "smoke",
    label: "Smoke",
    hint: "One scenario per feature, role and interface, built from the bundle examples. Free: no model call.",
    unavailableReason: null,
  },
  {
    value: "standard",
    label: "Standard",
    hint: "Adds paraphrases and negative cases written by the model. Costs money: see the estimate.",
    unavailableReason: null,
  },
  {
    value: "deep",
    label: "Deep",
    hint: "The broadest set: also role variants and adversarial cases. Costs the most.",
    unavailableReason: null,
  },
];

function isDepth(value: string): value is Depth {
  return DEPTH_OPTIONS.some((option) => option.value === value);
}

export function DepthPicker({ value, onChange, error, disabled = false }: DepthPickerProps) {
  const groupId = useId();
  const errorId = `${groupId}-error`;

  return (
    <OptionSection title="Depth" description="How many scenarios to build for each cell.">
      <RadioGroup
        aria-label="Depth"
        aria-invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : errorId}
        value={value}
        onValueChange={(next) => {
          if (isDepth(next)) {
            onChange(next);
          }
        }}
      >
        {DEPTH_OPTIONS.map((option) => {
          const itemId = `${groupId}-${option.value}`;
          const reasonId = `${itemId}-reason`;
          return (
            <div key={option.value} className="flex items-start gap-2">
              <RadioGroupItem
                id={itemId}
                value={option.value}
                disabled={disabled || option.unavailableReason !== null}
                aria-describedby={option.unavailableReason === null ? undefined : reasonId}
                className="mt-0.5"
              />
              <div className="flex flex-col gap-0.5">
                <Label htmlFor={itemId} className="leading-snug font-normal">
                  {option.label}
                </Label>
                <p className="text-xs text-muted-foreground">{option.hint}</p>
                {option.unavailableReason === null ? null : (
                  <p id={reasonId} className="text-xs text-muted-foreground">
                    {option.unavailableReason}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </RadioGroup>
      {error === undefined ? null : (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </OptionSection>
  );
}
