import {
  Ban,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleX,
  PenLine,
  Shuffle,
  SkipForward,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { CELL_STATUS_LABELS, VERDICT_LABELS } from "../labels";
import type { CellStatus, VerdictStatus } from "../types";

interface CellStatusStyle {
  icon: LucideIcon;
  tone: string;
  text: string;
  pattern: string;
  outline: string;
}

export const CELL_STATUS_STYLES = {
  empty: {
    icon: CircleDashed,
    tone: "border-cell-empty-fg/50 bg-cell-empty-bg text-cell-empty-fg",
    text: "text-cell-empty-fg",
    pattern: "",
    outline: "border-dashed",
  },
  generated: {
    icon: Sparkles,
    tone: "border-cell-generated-fg/40 bg-cell-generated-bg text-cell-generated-fg",
    text: "text-cell-generated-fg",
    pattern: "cell-pattern-generated",
    outline: "",
  },
  covered: {
    icon: CircleCheck,
    tone: "border-cell-covered-fg/40 bg-cell-covered-bg text-cell-covered-fg",
    text: "text-cell-covered-fg",
    pattern: "",
    outline: "",
  },
  needs_author: {
    icon: PenLine,
    tone: "border-cell-needs-author-fg/40 bg-cell-needs-author-bg text-cell-needs-author-fg",
    text: "text-cell-needs-author-fg",
    pattern: "cell-pattern-needs-author",
    outline: "",
  },
  blocked: {
    icon: Ban,
    tone: "border-cell-blocked-fg/40 bg-cell-blocked-bg text-cell-blocked-fg",
    text: "text-cell-blocked-fg",
    pattern: "cell-pattern-blocked",
    outline: "",
  },
} as const satisfies Record<CellStatus, CellStatusStyle>;

const VERDICT_MARKS = {
  pass: { icon: CircleCheck, tone: "text-verdict-pass-fg" },
  fail: { icon: CircleX, tone: "text-verdict-fail-fg" },
  flaky: { icon: Shuffle, tone: "text-verdict-flaky-fg" },
  uncertain: { icon: CircleHelp, tone: "text-verdict-uncertain-fg" },
  skipped: { icon: SkipForward, tone: "text-verdict-skipped-fg" },
} as const satisfies Record<VerdictStatus, { icon: LucideIcon; tone: string }>;

export function CellStatusIcon({
  status,
  className,
}: {
  status: CellStatus;
  className?: string;
}) {
  const Icon = CELL_STATUS_STYLES[status].icon;
  return <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", className)} />;
}

export function CellStatusBadge({
  status,
  className,
  ...props
}: { status: CellStatus } & Omit<ComponentProps<"span">, "children">) {
  const style = CELL_STATUS_STYLES[status];
  return (
    <span
      data-slot="cell-status-badge"
      data-status={status}
      className={cn(
        "inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-4xl border px-2 text-xs font-medium whitespace-nowrap",
        style.tone,
        style.outline,
        style.pattern,
        className,
      )}
      {...props}
    >
      <CellStatusIcon status={status} className="size-3" />
      {CELL_STATUS_LABELS[status]}
    </span>
  );
}

export function LastVerdictMark({
  verdict,
  className,
}: {
  verdict: VerdictStatus | null;
  className?: string;
}) {
  if (verdict === null) {
    return null;
  }
  const { icon: Icon, tone } = VERDICT_MARKS[verdict];
  return (
    <span
      data-slot="last-verdict"
      data-verdict={verdict}
      className={cn("inline-flex items-center", tone, className)}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      <span className="sr-only">Last verdict: {VERDICT_LABELS[verdict]}</span>
    </span>
  );
}
