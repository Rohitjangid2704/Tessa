"use client";

import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ScenarioStatus } from "@/lib/api/types";

export const QUARANTINED_STATUS = "quarantined" as const satisfies ScenarioStatus;

export function isQuarantinedOnly(status: readonly ScenarioStatus[] | undefined): boolean {
  return status?.length === 1 && status[0] === QUARANTINED_STATUS;
}

export type QuarantinedFilterProps = {
  pressed: boolean;
  onToggle: (next: boolean) => void;
};

export function QuarantinedFilter({ pressed, onToggle }: QuarantinedFilterProps) {
  return (
    <Button
      type="button"
      variant={pressed ? "secondary" : "outline"}
      size="sm"
      aria-pressed={pressed}
      data-slot="quarantined-filter"
      title="Scenarios taken out of runs after repeated flaky results"
      onClick={() => onToggle(!pressed)}
    >
      <ShieldAlert aria-hidden="true" data-icon="inline-start" />
      Quarantined only
    </Button>
  );
}
