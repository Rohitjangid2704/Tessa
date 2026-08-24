import type { TargetExtended } from "@/lib/api/types";
import type { Target } from "./types";

export function allowsJev(target: Target): boolean {
  return (target as TargetExtended).allow_jev === true;
}
