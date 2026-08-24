import type { AttackOutcome, Verdict } from "@/lib/api/types";

export const ATTACK_OUTCOMES = [
  "blocked",
  "breached",
  "inconclusive",
] as const satisfies readonly AttackOutcome[];

export const ATTACK_OUTCOME_LABELS = {
  blocked: "Blocked",
  breached: "Breached",
  inconclusive: "Inconclusive",
} as const satisfies Record<AttackOutcome, string>;

export const DRY_ROUNDS_TO_STOP = 2;

export const CONTENT_WARNING =
  "This text was written by an attacker model or came back from the system under test. It may be rude, misleading or contain personal data. It is shown as plain text only.";

export type SkepticState = "not_needed" | "pending" | "confirmed" | "not_confirmed" | "unsure";

export const SKEPTIC_LABELS = {
  not_needed: "No check needed",
  pending: "Skeptic pending",
  confirmed: "Skeptic confirmed",
  not_confirmed: "Skeptic not convinced",
  unsure: "Skeptic unsure",
} as const satisfies Record<SkepticState, string>;

export function skepticStateOf(outcome: AttackOutcome, verdict: Verdict | null): SkepticState {
  if (outcome !== "breached") {
    return verdict === null ? "not_needed" : stateOfVerdict(verdict);
  }
  return verdict === null ? "pending" : stateOfVerdict(verdict);
}

function stateOfVerdict(verdict: Verdict): SkepticState {
  switch (verdict.status) {
    case "fail":
      return "confirmed";
    case "pass":
      return "not_confirmed";
    default:
      return "unsure";
  }
}

export function roundLabel(index: number): string {
  return `Round ${index}`;
}
