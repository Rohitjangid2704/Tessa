import { describeAdapterLabel } from "@/features/adapters/registry";
import type { PlanSkippedItem, SkipReason } from "./types";

export interface SkipReasonText {
  label: string;
  description: string;
}

export const PLAN_SKIP_REASON_TEXT: Record<SkipReason, SkipReasonText> = {
  service_down: {
    label: "Service down",
    description: "A service the feature depends on failed its last health check.",
  },
  hook_missing: {
    label: "Test hook missing",
    description: "The feature needs a test hook the bundle does not declare.",
  },
  precondition_failed: {
    label: "No example to run",
    description: "The bundle has no example the smoke scenario can be built from.",
  },
  env_missing: {
    label: "Environment value missing",
    description: "A required environment value is not set for this target.",
  },
  role_unavailable: {
    label: "Role unavailable",
    description: "None of the selected roles can use the feature, or a role credential is missing.",
  },
  budget_exceeded: {
    label: "Budget exceeded",
    description: "The budget ran out before the scenario started.",
  },
  canceled: {
    label: "Canceled",
    description: "The run was canceled before the scenario started.",
  },
  production_blocked: {
    label: "Write blocked on production",
    description: "Write features never run against a production target.",
  },
  flag_disabled: {
    label: "Feature flag off",
    description: "The feature flag the feature sits behind is switched off.",
  },
  quarantined: {
    label: "Quarantined",
    description: "The scenario was quarantined after repeated flaky results.",
  },
  seed_mismatch: {
    label: "Seed mismatch",
    description: "The seed hash did not match, so the scenario would not be trustworthy.",
  },
  adapter_unsupported: {
    label: "No matching interface",
    description:
      "None of the feature's interfaces fits the chosen interface mode, or its adapter is not supported yet.",
  },
};

export function describePlanSkipReason(
  reason: SkipReason,
  adapterKind?: string | null,
): SkipReasonText {
  const text = PLAN_SKIP_REASON_TEXT[reason];
  if (reason !== "adapter_unsupported" || adapterKind === undefined || adapterKind === null) {
    return text;
  }
  const adapter = describeAdapterLabel(adapterKind);
  return {
    label: `${adapter} interface not supported`,
    description: `The ${adapter} adapter cannot drive this feature's interface yet, or the interface does not fit the chosen interface mode.`,
  };
}

export interface SkippedGroup {
  reason: SkipReason;
  items: PlanSkippedItem[];
}

export function groupSkipped(skipped: readonly PlanSkippedItem[]): SkippedGroup[] {
  const groups = new Map<SkipReason, PlanSkippedItem[]>();
  for (const item of skipped) {
    const existing = groups.get(item.reason);
    if (existing === undefined) {
      groups.set(item.reason, [item]);
    } else {
      existing.push(item);
    }
  }
  return [...groups.entries()].map(([reason, items]) => ({ reason, items }));
}

export function describeSkippedItem(item: PlanSkippedItem): string {
  const parts = [item.feature_id];
  if (item.role !== null) {
    parts.push(item.role);
  }
  if (item.interface_id !== null) {
    parts.push(item.interface_id);
  }
  return parts.join(" · ");
}
