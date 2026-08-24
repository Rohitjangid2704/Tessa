import { describeAdapterLabel } from "@/features/adapters/registry";
import type { SkipReason, Verdict } from "@/lib/api/types";

export interface SkipReasonText {
  label: string;
  explanation: string;
  loud: boolean;
}

export const SKIP_REASON_TEXT = {
  service_down: {
    label: "Service down",
    explanation:
      "The interface this scenario needs failed its health check, so the scenario was not run.",
    loud: false,
  },
  hook_missing: {
    label: "Hook missing",
    explanation:
      "The app does not offer a hook this scenario needs, such as resetting data or pinning the clock.",
    loud: false,
  },
  precondition_failed: {
    label: "Precondition failed",
    explanation:
      "A precondition of the scenario did not hold, for example the example data it relies on is absent.",
    loud: false,
  },
  env_missing: {
    label: "Environment value missing",
    explanation:
      "A required environment value has no value in the environment vault, so the scenario could not log in or call the app.",
    loud: false,
  },
  role_unavailable: {
    label: "Role unavailable",
    explanation: "No credentials exist for the role this scenario runs as.",
    loud: false,
  },
  budget_exceeded: {
    label: "Budget exceeded",
    explanation:
      "The run reached its cost or time limit before this scenario started, so it was left out. Raise the budget and run again to cover it.",
    loud: true,
  },
  canceled: {
    label: "Canceled",
    explanation: "The run was canceled before this scenario started.",
    loud: false,
  },
  production_blocked: {
    label: "Blocked on production",
    explanation:
      "This target is production and the scenario writes data, so it was not run. Production runs are read-only.",
    loud: true,
  },
  flag_disabled: {
    label: "Feature flag off",
    explanation: "A feature flag this scenario depends on is disabled in the app.",
    loud: false,
  },
  quarantined: {
    label: "Quarantined",
    explanation: "The scenario is quarantined and is not run until it is accepted again.",
    loud: false,
  },
  seed_mismatch: {
    label: "Seed data mismatch",
    explanation:
      "The target's data does not match the seed this scenario expects, so any result would be untrustworthy and the scenario was not run.",
    loud: true,
  },
  adapter_unsupported: {
    label: "Adapter unsupported",
    explanation: "No adapter can drive the interface this scenario needs.",
    loud: false,
  },
} as const satisfies Record<SkipReason, SkipReasonText>;

export function describeSkipReason(
  reason: SkipReason,
  adapterKind?: string | null,
): SkipReasonText {
  const text = SKIP_REASON_TEXT[reason];
  if (reason !== "adapter_unsupported" || adapterKind === undefined || adapterKind === null) {
    return text;
  }
  const adapter = describeAdapterLabel(adapterKind);
  return {
    label: `${adapter} adapter unsupported`,
    explanation: `No adapter can drive the ${adapter} interface this scenario needs, so the scenario was not run.`,
    loud: text.loud,
  };
}

export function isLoudSkipReason(reason: SkipReason): boolean {
  return SKIP_REASON_TEXT[reason].loud;
}

export interface LoudSkipTally {
  reason: SkipReason;
  count: number;
}

export function tallyLoudSkips(
  items: readonly { verdict: Pick<Verdict, "skip_reason"> | null }[],
): LoudSkipTally[] {
  const counts = new Map<SkipReason, number>();
  for (const item of items) {
    const reason = item.verdict?.skip_reason ?? null;
    if (reason !== null && isLoudSkipReason(reason)) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }
  return [...counts].map(([reason, count]) => ({ reason, count }));
}
