"use client";

import { useId } from "react";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  INTERFACE_MODE_LABELS,
  interfaceModeAvailability,
  type InterfaceCapabilities,
} from "../plan-selection";
import type { InterfaceMode } from "../types";
import { OptionSection } from "./option-section";

export interface InterfaceModePickerProps {
  value: InterfaceMode;
  capabilities: InterfaceCapabilities;
  onChange: (mode: InterfaceMode) => void;
  disabled?: boolean;
}

const MODES = ["both", "api_only", "browser_only"] as const satisfies readonly InterfaceMode[];

const MODE_HINTS: Record<InterfaceMode, string> = {
  both: "Every interface a feature declares",
  api_only: "HTTP, SSE and every other interface except the browser",
  browser_only: "Drive the app in a real browser and watch it live",
};

function isInterfaceMode(value: string): value is InterfaceMode {
  return (MODES as readonly string[]).includes(value);
}

export function InterfaceModePicker({
  value,
  capabilities,
  onChange,
  disabled = false,
}: InterfaceModePickerProps) {
  const groupId = useId();

  return (
    <OptionSection title="Interfaces" description="Which kinds of interface to run through.">
      <RadioGroup
        aria-label="Interfaces"
        value={value}
        onValueChange={(next) => {
          if (isInterfaceMode(next)) {
            onChange(next);
          }
        }}
      >
        {MODES.map((mode) => {
          const availability = interfaceModeAvailability(mode, capabilities);
          const itemId = `${groupId}-${mode}`;
          const reasonId = `${itemId}-reason`;
          return (
            <div key={mode} className="flex items-start gap-2">
              <RadioGroupItem
                id={itemId}
                value={mode}
                disabled={disabled || !availability.enabled}
                aria-describedby={availability.reason === null ? undefined : reasonId}
                className="mt-0.5"
              />
              <div className="flex flex-col gap-0.5">
                <Label htmlFor={itemId} className="leading-snug font-normal">
                  {INTERFACE_MODE_LABELS[mode]}
                </Label>
                <p className="text-xs text-muted-foreground">{MODE_HINTS[mode]}</p>
                {availability.reason === null ? null : (
                  <p id={reasonId} className="text-xs text-muted-foreground">
                    {availability.reason}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </RadioGroup>
    </OptionSection>
  );
}
