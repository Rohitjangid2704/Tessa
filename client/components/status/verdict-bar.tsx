import {
  CircleCheck,
  CircleHelp,
  CircleX,
  Shuffle,
  SkipForward,
  type LucideIcon,
} from "lucide-react";
import type { ComponentProps } from "react";
import type { RunCounters } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import type { VerdictStatus } from "./status-types";
import { toneClasses, type Tone } from "./tones";

const verdictCounterPresentation = {
  pass: { tone: "verdict-pass", label: "Pass", icon: CircleCheck },
  fail: { tone: "verdict-fail", label: "Fail", icon: CircleX },
  flaky: { tone: "verdict-flaky", label: "Flaky", icon: Shuffle },
  uncertain: { tone: "verdict-uncertain", label: "Uncertain", icon: CircleHelp },
  skipped: { tone: "verdict-skipped", label: "Skipped", icon: SkipForward },
} as const satisfies Record<VerdictStatus, { tone: Tone; label: string; icon: LucideIcon }>;

const COUNTER_ORDER = ["pass", "fail", "flaky", "uncertain", "skipped"] as const;

export type VerdictBarProps = {
  counters: Pick<RunCounters, VerdictStatus | "scenarios_total" | "scenarios_done">;
  hideZero?: boolean;
  showProgress?: boolean;
} & Omit<ComponentProps<"ul">, "children">;

export function VerdictBar({
  counters,
  hideZero = false,
  showProgress = false,
  className,
  ...props
}: VerdictBarProps) {
  const visible = COUNTER_ORDER.filter((verdict) => !hideZero || counters[verdict] > 0);
  return (
    <ul
      aria-label="Verdict counters"
      data-slot="verdict-bar"
      className={cn("flex flex-wrap items-center gap-1.5", className)}
      {...props}
    >
      {showProgress ? (
        <li
          data-slot="verdict-progress"
          className="text-xs font-medium text-muted-foreground tabular-nums"
        >
          {counters.scenarios_done} of {counters.scenarios_total} scenarios done
        </li>
      ) : null}
      {visible.map((verdict) => {
        const { tone, label, icon: Icon } = verdictCounterPresentation[verdict];
        const count = counters[verdict];
        return (
          <li
            key={verdict}
            data-slot="verdict-counter"
            data-verdict={verdict}
            data-count={count}
            className={cn(
              "inline-flex h-5 items-center gap-1 rounded-4xl border px-2 text-xs font-medium whitespace-nowrap tabular-nums",
              count > 0 ? toneClasses[tone] : toneClasses.hollow,
            )}
          >
            <Icon aria-hidden="true" className="size-3 shrink-0" />
            <span>{label}</span>
            <span data-slot="verdict-count">{count}</span>
          </li>
        );
      })}
    </ul>
  );
}
