"use client";

import { useId } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { OptionSection } from "./option-section";

export interface ApiFuzzToggleProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}

const FUZZ_DESCRIPTION =
  "Adds one generated scenario per role that sends fuzzed requests to the operations in the bundle's openapi.json. Findings arrive as class contract or server_error. A bundle without openapi.json skips this family.";

export function ApiFuzzToggle({ checked, onCheckedChange, disabled = false }: ApiFuzzToggleProps) {
  const switchId = useId();
  const descriptionId = `${switchId}-description`;

  return (
    <OptionSection title="API fuzz">
      <div className="flex items-start gap-3">
        <Switch
          id={switchId}
          checked={checked}
          disabled={disabled}
          aria-describedby={descriptionId}
          onCheckedChange={onCheckedChange}
          className="mt-0.5"
        />
        <div className="flex flex-col gap-1">
          <Label htmlFor={switchId} className="leading-snug font-normal">
            Include API fuzz
          </Label>
          <p id={descriptionId} className="text-xs text-muted-foreground">
            {FUZZ_DESCRIPTION}
          </p>
        </div>
      </div>
    </OptionSection>
  );
}
