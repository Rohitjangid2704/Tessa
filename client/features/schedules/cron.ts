import cronstrue from "cronstrue";
import type { ScheduleTier } from "@/lib/api/types";

export const CRON_FIELD_COUNT = 5;

export const CRON_FIELD_COUNT_MESSAGE =
  "A cron expression has 5 fields: minute, hour, day of month, month and day of week";

export interface CronPreset {
  id: string;
  label: string;
  cron: string;
}

export const CRON_PRESETS: readonly CronPreset[] = [
  { id: "nightly", label: "Nightly at 02:00", cron: "0 2 * * *" },
  { id: "weekdays", label: "Weekdays at 08:00", cron: "0 8 * * 1-5" },
  { id: "weekly", label: "Mondays at 03:00", cron: "0 3 * * 1" },
];

const TIER_PRESET_IDS: Readonly<Partial<Record<ScheduleTier, string>>> = {
  nightly: "nightly",
  weekly: "weekly",
};

export function tierRequiresCron(tier: ScheduleTier): boolean {
  return tier !== "commit";
}

export function presetCronOfTier(tier: ScheduleTier): string {
  const presetId = TIER_PRESET_IDS[tier];
  return CRON_PRESETS.find((preset) => preset.id === presetId)?.cron ?? "";
}

export function cronForTierChange(
  nextTier: ScheduleTier,
  previousTier: ScheduleTier,
  currentCron: string,
): string {
  if (!tierRequiresCron(nextTier)) {
    return "";
  }
  const typed = currentCron.trim();
  return typed === "" || typed === presetCronOfTier(previousTier)
    ? presetCronOfTier(nextTier)
    : currentCron;
}

export function cronFieldCount(expression: string): number {
  const trimmed = expression.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

export function validateCronShape(expression: string): string | null {
  if (expression.trim() === "") {
    return "Enter a cron expression";
  }
  return cronFieldCount(expression) === CRON_FIELD_COUNT ? null : CRON_FIELD_COUNT_MESSAGE;
}

export function describeCron(expression: string): string | null {
  const trimmed = expression.trim();
  if (trimmed === "") {
    return null;
  }
  try {
    return cronstrue.toString(trimmed, { use24HourTimeFormat: true });
  } catch {
    return null;
  }
}
