import type { MutationSummary } from "@/lib/api/types";
import { pluralize } from "@/features/findings/labels";

export type KpiTone = "good" | "warn" | "bad" | "neutral";

export interface MutationHeadline {
  text: string;
  tone: KpiTone;
  statusLabel: string;
  survivorNames: readonly string[];
}

export type MutationHeadlineInput = Pick<MutationSummary, "killed" | "total" | "survivors">;

export function describeMutationHeadline(summary: MutationHeadlineInput): MutationHeadline {
  const survivorNames = summary.survivors.map((survivor) => survivor.name);
  if (summary.total === 0) {
    return {
      text: "No known bugs are registered yet",
      tone: "neutral",
      statusLabel: "No mutants",
      survivorNames,
    };
  }
  const text = `The suite kills ${summary.killed} of ${summary.total} known bugs`;
  const notKilled = summary.total - summary.killed;
  if (survivorNames.length > 0) {
    return {
      text,
      tone: "warn",
      statusLabel: `${survivorNames.length} ${pluralize(survivorNames.length, "survivor")}`,
      survivorNames,
    };
  }
  if (notKilled > 0) {
    return { text, tone: "warn", statusLabel: `${notKilled} not killed`, survivorNames };
  }
  return { text, tone: "good", statusLabel: "All killed", survivorNames };
}

export function describeSurvivors(names: readonly string[]): string {
  if (names.length === 0) {
    return "";
  }
  return `${pluralize(names.length, "Survivor")}: ${names.join(", ")}`;
}
