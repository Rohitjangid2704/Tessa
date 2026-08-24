import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  hasBudgetErrors,
  resolveBudgetInput,
  type BudgetFieldErrors,
} from "@/features/plans/budget-input";
import { settingsQuery } from "@/features/settings/queries";
import type { Budget } from "@/lib/api/types";

export interface StartBudget {
  maxUsd: string;
  maxMinutes: string;
  setMaxUsd: (value: string) => void;
  setMaxMinutes: (value: string) => void;
  budget: Budget | null;
  errors: BudgetFieldErrors;
  loading: boolean;
  defaultsFailed: boolean;
}

interface Edits {
  maxUsd: string | null;
  maxMinutes: string | null;
}

const NO_EDITS: Edits = { maxUsd: null, maxMinutes: null };

export function useStartBudget(): StartBudget {
  const settings = useQuery(settingsQuery());
  const [edits, setEdits] = useState<Edits>(NO_EDITS);

  const defaults: Budget | null =
    settings.data === undefined
      ? null
      : {
          max_usd: settings.data.budgets.default_max_usd,
          max_minutes: settings.data.budgets.default_max_minutes,
        };

  const maxUsd = edits.maxUsd ?? (defaults === null ? "" : String(defaults.max_usd));
  const maxMinutes = edits.maxMinutes ?? (defaults === null ? "" : String(defaults.max_minutes));
  const resolution = resolveBudgetInput({ maxUsd, maxMinutes }, defaults);
  const blocked = hasBudgetErrors(resolution.errors);
  const budget = blocked ? null : (resolution.budget ?? defaults);

  return {
    maxUsd,
    maxMinutes,
    setMaxUsd: (value) => setEdits((current) => ({ ...current, maxUsd: value })),
    setMaxMinutes: (value) => setEdits((current) => ({ ...current, maxMinutes: value })),
    budget,
    errors: resolution.errors,
    loading: settings.isPending,
    defaultsFailed: settings.isError,
  };
}
