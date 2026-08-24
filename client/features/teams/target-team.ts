import type { Target } from "@/features/targets/types";
import type { TargetExtended } from "@/lib/api/types";

export function teamIdOfTarget(target: Target): string | null {
  return (target as TargetExtended).team_id ?? null;
}
