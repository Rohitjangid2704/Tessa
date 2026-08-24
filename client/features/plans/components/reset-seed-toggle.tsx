"use client";

import { useId } from "react";
import { RoleGate } from "@/components/role-gate";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { OptionSection } from "./option-section";

export interface ResetSeedToggleProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  productionTarget: boolean;
  disabled?: boolean;
}

const RESET_DESCRIPTION =
  "Resets the target's seed data before the run checks its hash. Destructive: changes made in the target since the last reset are lost.";
const PRODUCTION_DESCRIPTION =
  "Not available on a production target: resetting its data is always blocked.";

export function ResetSeedToggle({
  checked,
  onCheckedChange,
  productionTarget,
  disabled = false,
}: ResetSeedToggleProps) {
  const switchId = useId();
  const descriptionId = `${switchId}-description`;

  return (
    <RoleGate action="runs.start">
      <OptionSection title="Seed">
        <div className="flex items-start gap-3">
          <Switch
            id={switchId}
            checked={checked && !productionTarget}
            disabled={disabled || productionTarget}
            aria-describedby={descriptionId}
            onCheckedChange={onCheckedChange}
            className="mt-0.5"
          />
          <div className="flex flex-col gap-1">
            <Label htmlFor={switchId} className="leading-snug font-normal">
              Reset seed first
            </Label>
            <p id={descriptionId} className="text-xs text-muted-foreground">
              {productionTarget ? PRODUCTION_DESCRIPTION : RESET_DESCRIPTION}
            </p>
          </div>
        </div>
      </OptionSection>
    </RoleGate>
  );
}
