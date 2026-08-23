import { Check, CircleAlert, X } from "lucide-react";
import { StatusBadge, type StatusBadgeProps } from "@/components/status/status-badge";
import type { BundleCompletenessStatus, BundleValidationStatus } from "../format";

type PassthroughProps = Omit<StatusBadgeProps, "tone" | "label" | "icon">;

export function ValidationBadge({
  status,
  ...props
}: { status: BundleValidationStatus } & PassthroughProps) {
  return status === "valid" ? (
    <StatusBadge tone="verdict-pass" label="Valid" icon={Check} {...props} />
  ) : (
    <StatusBadge tone="verdict-fail" label="Invalid" icon={X} {...props} />
  );
}

export function CompletenessBadge({
  status,
  ...props
}: { status: BundleCompletenessStatus } & PassthroughProps) {
  return status === "meets_bar" ? (
    <StatusBadge tone="verdict-pass" label="Meets bar" icon={Check} {...props} />
  ) : (
    <StatusBadge tone="verdict-flaky" label="Below bar" icon={CircleAlert} {...props} />
  );
}
