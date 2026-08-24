"use client";

import { Minus, Plus } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { clampAttempts, PLAN_K_MAX, PLAN_K_MIN } from "../schemas";
import { OptionSection } from "./option-section";

export interface AttemptsStepperProps {
  value: number;
  onChange: (attempts: number) => void;
  error?: string;
  disabled?: boolean;
}

export function AttemptsStepper({
  value,
  onChange,
  error,
  disabled = false,
}: AttemptsStepperProps) {
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const describedBy = error === undefined ? hintId : `${hintId} ${errorId}`;

  return (
    <OptionSection title="Attempts">
      <Label htmlFor={inputId} className="font-normal">
        Attempts per scenario (k)
      </Label>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Fewer attempts"
          disabled={disabled || value <= PLAN_K_MIN}
          onClick={() => onChange(clampAttempts(value - 1))}
        >
          <Minus aria-hidden="true" />
        </Button>
        <Input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={PLAN_K_MIN}
          max={PLAN_K_MAX}
          step={1}
          value={value}
          disabled={disabled}
          aria-invalid={error !== undefined}
          aria-describedby={describedBy}
          onChange={(event) => {
            const parsed = event.target.valueAsNumber;
            if (Number.isFinite(parsed)) {
              onChange(clampAttempts(parsed));
            }
          }}
          className="w-16 text-center tabular-nums"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="More attempts"
          disabled={disabled || value >= PLAN_K_MAX}
          onClick={() => onChange(clampAttempts(value + 1))}
        >
          <Plus aria-hidden="true" />
        </Button>
      </div>
      <p id={hintId} className="text-xs text-muted-foreground">
        Each scenario runs {PLAN_K_MIN} to {PLAN_K_MAX} times. Mixed results mark it flaky.
      </p>
      {error === undefined ? null : (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </OptionSection>
  );
}
