import type { FindingStatus } from "@/lib/api/types";

export const USER_TRANSITIONS: Readonly<Record<FindingStatus, readonly FindingStatus[]>> = {
  new: ["triaged", "in_fix", "known_gap", "dismissed"],
  triaged: ["new", "in_fix", "known_gap", "dismissed"],
  in_fix: ["triaged", "verifying", "known_gap", "dismissed"],
  verifying: ["in_fix", "triaged"],
  resolved: ["triaged"],
  known_gap: ["triaged", "dismissed"],
  dismissed: ["triaged"],
};

export function userMayMove(from: FindingStatus, to: FindingStatus): boolean {
  return USER_TRANSITIONS[from].includes(to);
}
