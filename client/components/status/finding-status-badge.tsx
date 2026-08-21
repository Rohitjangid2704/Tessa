import {
  Archive,
  CircleDashed,
  CircleDot,
  CircleCheck,
  EyeOff,
  SearchCheck,
  Wrench,
} from "lucide-react";
import type { FindingStatus } from "@/lib/api/types";
import { StatusBadge, type StatusBadgeProps } from "./status-badge";

export const findingStatusPresentation = {
  new: { tone: "finding-new", label: "New", icon: CircleDot },
  triaged: { tone: "finding-triaged", label: "Triaged", icon: CircleDashed },
  in_fix: { tone: "finding-in-fix", label: "In fix", icon: Wrench },
  verifying: { tone: "finding-verifying", label: "Verifying", icon: SearchCheck },
  resolved: { tone: "finding-resolved", label: "Resolved", icon: CircleCheck },
  known_gap: { tone: "finding-known-gap", label: "Known gap", icon: Archive },
  dismissed: { tone: "finding-dismissed", label: "Dismissed", icon: EyeOff },
} as const satisfies Record<FindingStatus, Pick<StatusBadgeProps, "tone" | "label" | "icon">>;

export function FindingStatusBadge({
  status,
  ...props
}: { status: FindingStatus } & Omit<StatusBadgeProps, "tone" | "label" | "icon">) {
  return <StatusBadge {...findingStatusPresentation[status]} {...props} />;
}
