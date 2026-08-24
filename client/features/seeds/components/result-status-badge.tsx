import { CircleCheck, CircleDashed, CircleX, TriangleAlert } from "lucide-react";
import { StatusBadge, type StatusBadgeProps } from "@/components/status/status-badge";
import { RESET_STATUS_LABELS } from "../hash-state";
import type { SeedResetStatus } from "../types";

const presentation = {
  ok: { tone: "verdict-pass", icon: CircleCheck },
  failed: { tone: "verdict-fail", icon: TriangleAlert },
  mismatch: { tone: "verdict-fail", icon: CircleX },
} as const satisfies Record<SeedResetStatus, Pick<StatusBadgeProps, "tone" | "icon">>;

export function ResultStatusBadge({
  status,
  ...props
}: { status: SeedResetStatus | null } & Omit<StatusBadgeProps, "tone" | "label" | "icon">) {
  if (status === null) {
    return <StatusBadge tone="hollow" label="Never reset" icon={CircleDashed} {...props} />;
  }
  return <StatusBadge {...presentation[status]} label={RESET_STATUS_LABELS[status]} {...props} />;
}
