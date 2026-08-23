import type { FilterOption } from "@/components/filter-bar";
import { SEVERITIES } from "@/components/status/status-types";
import type { FindingClass, FindingStatus } from "@/lib/api/types";
import {
  FINDING_CLASS_LABELS,
  FINDING_STATUS_LABELS,
  FINDING_STATUSES,
  SEVERITY_LABELS,
} from "./detail-schemas";

export const FINDING_CLASSES = [
  "wrong_result",
  "invariant_violation",
  "server_error",
  "security_boundary",
  "safety_claim",
  "performance",
  "accessibility",
  "flaky",
  "contract",
  "harness",
] as const satisfies readonly FindingClass[];

export const COLLAPSED_BY_DEFAULT: readonly FindingStatus[] = ["resolved", "dismissed"];

export const STATUS_FILTER_OPTIONS: readonly FilterOption[] = FINDING_STATUSES.map((status) => ({
  value: status,
  label: FINDING_STATUS_LABELS[status],
}));

export const SEVERITY_FILTER_OPTIONS: readonly FilterOption[] = SEVERITIES.map((severity) => ({
  value: severity,
  label: SEVERITY_LABELS[severity],
}));

export const CLASS_FILTER_OPTIONS: readonly FilterOption[] = FINDING_CLASSES.map((findingClass) => ({
  value: findingClass,
  label: FINDING_CLASS_LABELS[findingClass],
}));

export function invariantFilterOptions(
  known: readonly { id: string; title: string }[] | undefined,
  selected: readonly string[] | undefined,
): FilterOption[] {
  const options = new Map<string, string>();
  for (const entry of known ?? []) {
    options.set(entry.id, entry.title);
  }
  for (const id of selected ?? []) {
    if (!options.has(id)) {
      options.set(id, id);
    }
  }
  return [...options.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function pluralize(count: number, singular: string, plural: string = `${singular}s`): string {
  return count === 1 ? singular : plural;
}
