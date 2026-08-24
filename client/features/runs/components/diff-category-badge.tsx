import {
  Ban,
  CircleCheck,
  CircleX,
  Equal,
  Minus,
  Plus,
  Repeat,
  Shuffle,
  type LucideIcon,
} from "lucide-react";
import { StatusBadge } from "@/components/status/status-badge";
import type { Tone } from "@/components/status/tones";
import type { RunDiffCategory } from "@/lib/api/types";

interface CategoryPresentation {
  tone: Tone;
  label: string;
  icon: LucideIcon;
  explanation: string;
}

export const DIFF_CATEGORY_PRESENTATION = {
  new_failure: {
    tone: "verdict-fail",
    label: "New failure",
    icon: CircleX,
    explanation: "Passed in the other run and fails in this run",
  },
  fixed: {
    tone: "verdict-pass",
    label: "Fixed",
    icon: CircleCheck,
    explanation: "Failed in the other run and passes in this run",
  },
  still_failing: {
    tone: "verdict-fail",
    label: "Still failing",
    icon: Repeat,
    explanation: "Fails in both runs",
  },
  flaky_change: {
    tone: "verdict-flaky",
    label: "Flaky change",
    icon: Shuffle,
    explanation: "Became flaky or stopped being flaky between the runs",
  },
  unchanged: {
    tone: "hollow",
    label: "Unchanged",
    icon: Equal,
    explanation: "Same verdict in both runs",
  },
  added: {
    tone: "tier-code",
    label: "Added",
    icon: Plus,
    explanation: "Only in this run, so there is nothing to compare with",
  },
  removed: {
    tone: "hollow",
    label: "Removed",
    icon: Minus,
    explanation: "Only in the other run, so there is nothing to compare with",
  },
  not_comparable: {
    tone: "verdict-skipped",
    label: "Not comparable",
    icon: Ban,
    explanation: "Skipped or undecided in one of the runs, so no verdict change can be stated",
  },
} as const satisfies Record<RunDiffCategory, CategoryPresentation>;

export const CHANGE_CATEGORIES = [
  "new_failure",
  "fixed",
  "still_failing",
  "flaky_change",
] as const satisfies readonly RunDiffCategory[];

export function DiffCategoryBadge({ category }: { category: RunDiffCategory }) {
  const { tone, label, icon, explanation } = DIFF_CATEGORY_PRESENTATION[category];
  return (
    <StatusBadge
      tone={tone}
      label={label}
      icon={icon}
      title={explanation}
      data-slot="diff-category"
      data-category={category}
    />
  );
}
