import {
  CircleCheck,
  CircleHelp,
  CircleX,
  Shuffle,
  SkipForward,
  type LucideIcon,
} from "lucide-react";
import { StatusBadge } from "@/components/status/status-badge";
import type { VerdictStatus } from "@/components/status/status-types";
import { toneClasses, type Tone } from "@/components/status/tones";
import { cn } from "@/lib/utils";

interface InvariantStatusPresentation {
  tone: Tone;
  label: string;
  icon: LucideIcon;
  hatched: boolean;
}

export const INVARIANT_STATUS_PRESENTATION = {
  pass: { tone: "verdict-pass", label: "Pass", icon: CircleCheck, hatched: false },
  fail: { tone: "verdict-fail", label: "Fail", icon: CircleX, hatched: false },
  flaky: { tone: "verdict-flaky", label: "Flaky", icon: Shuffle, hatched: false },
  uncertain: { tone: "verdict-flaky", label: "Uncertain", icon: CircleHelp, hatched: true },
  skipped: { tone: "verdict-skipped", label: "Skipped", icon: SkipForward, hatched: false },
} as const satisfies Record<VerdictStatus, InvariantStatusPresentation>;

export const INVARIANT_STATUS_ORDER = [
  "pass",
  "fail",
  "flaky",
  "uncertain",
  "skipped",
] as const satisfies readonly VerdictStatus[];

export function InvariantStatusBadge({ status }: { status: VerdictStatus }) {
  const { tone, label, icon, hatched } = INVARIANT_STATUS_PRESENTATION[status];
  return (
    <StatusBadge
      tone={tone}
      label={label}
      icon={icon}
      data-slot="invariant-status"
      data-status={status}
      className={cn(hatched && "hatched")}
    />
  );
}

export type InvariantCountChipsProps = {
  counts: Record<VerdictStatus, number>;
};

export function InvariantCountChips({ counts }: InvariantCountChipsProps) {
  return (
    <ul aria-label="Results by status" className="flex flex-wrap items-center gap-1.5">
      {INVARIANT_STATUS_ORDER.map((status) => {
        const { tone, label, icon: Icon, hatched } = INVARIANT_STATUS_PRESENTATION[status];
        const count = counts[status];
        return (
          <li
            key={status}
            data-slot="invariant-count"
            data-status={status}
            data-count={count}
            className={cn(
              "inline-flex h-5 items-center gap-1 rounded-4xl border px-2 text-xs font-medium whitespace-nowrap tabular-nums",
              count > 0 ? toneClasses[tone] : toneClasses.hollow,
              count > 0 && hatched && "hatched",
            )}
          >
            <Icon aria-hidden="true" className="size-3 shrink-0" />
            <span>{label}</span>
            <span>{count}</span>
          </li>
        );
      })}
    </ul>
  );
}
