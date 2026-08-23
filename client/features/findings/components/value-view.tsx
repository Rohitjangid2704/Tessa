"use client";

import { JsonView } from "@/features/steps/components/json-view";
import { TextView } from "@/features/steps/components/text-view";

export interface ValueViewProps {
  value: unknown;
  label: string;
}

export function ValueView({ value, label }: ValueViewProps) {
  if (typeof value === "string") {
    return <TextView text={value} label={label} />;
  }
  if (value === null || value === undefined) {
    return (
      <div role="group" aria-label={label} className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <p className="text-sm text-muted-foreground">Nothing was recorded.</p>
      </div>
    );
  }
  return <JsonView value={value} label={label} defaultOpenDepth={2} />;
}
