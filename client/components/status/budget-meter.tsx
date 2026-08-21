import { Clock, Wallet } from "lucide-react";
import type { ComponentProps } from "react";
import type { BudgetState } from "@/lib/api/types";
import { formatDuration } from "@/lib/format-duration";
import { formatUsd } from "@/lib/format-usd";
import { cn } from "@/lib/utils";

export type BudgetMeterProps = {
  budget: BudgetState;
} & Omit<ComponentProps<"dl">, "children">;

export function BudgetMeter({ budget, className, ...props }: BudgetMeterProps) {
  return (
    <dl
      aria-label="Budget"
      data-slot="budget-meter"
      className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-sm", className)}
      {...props}
    >
      <div className="flex items-center gap-1.5" data-slot="budget-cost">
        <dt className="flex items-center gap-1 text-muted-foreground">
          <Wallet aria-hidden="true" className="size-3.5" />
          Cost
        </dt>
        <dd className="font-medium tabular-nums">
          {formatUsd(budget.spent_usd)} of {formatUsd(budget.max_usd)}
        </dd>
      </div>
      <div className="flex items-center gap-1.5" data-slot="budget-time">
        <dt className="flex items-center gap-1 text-muted-foreground">
          <Clock aria-hidden="true" className="size-3.5" />
          Time
        </dt>
        <dd className="font-medium tabular-nums">
          {formatDuration(budget.elapsed_ms)} of {budget.max_minutes} min
        </dd>
      </div>
    </dl>
  );
}
