import {
  CircleCheck,
  CircleDashed,
  CircleX,
  Loader,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { StatusBadge, type StatusBadgeProps } from "@/components/status/status-badge";
import { Badge } from "@/components/ui/badge";
import { APPROVAL_LABELS, LANGUAGE_LABELS, RESULT_STATUS_LABELS } from "../schemas";
import type { OracleApproval, OracleLanguage, OracleResultStatus } from "../types";

type BadgeExtras = Omit<StatusBadgeProps, "tone" | "label" | "icon">;

const approvalPresentation = {
  unreviewed: { tone: "verdict-skipped", icon: CircleDashed },
  approved: { tone: "verdict-pass", icon: CircleCheck },
  rejected: { tone: "verdict-fail", icon: CircleX },
} as const satisfies Record<OracleApproval, Pick<StatusBadgeProps, "tone" | "icon">>;

const resultPresentation = {
  pending: { tone: "live-live", icon: Loader },
  ok: { tone: "verdict-skipped", icon: CircleCheck },
  error: { tone: "verdict-fail", icon: TriangleAlert },
} as const satisfies Record<OracleResultStatus, Pick<StatusBadgeProps, "tone" | "icon">>;

export function ApprovalBadge({ approval, ...props }: { approval: OracleApproval } & BadgeExtras) {
  return (
    <StatusBadge {...approvalPresentation[approval]} label={APPROVAL_LABELS[approval]} {...props} />
  );
}

export function ResultStatusBadge({
  status,
  ...props
}: { status: OracleResultStatus } & BadgeExtras) {
  return (
    <StatusBadge {...resultPresentation[status]} label={RESULT_STATUS_LABELS[status]} {...props} />
  );
}

export function ReadOnlyBadge({ verified, ...props }: { verified: boolean } & BadgeExtras) {
  return verified ? (
    <StatusBadge tone="tier-code" label="Read-only verified" icon={ShieldCheck} {...props} />
  ) : (
    <StatusBadge
      tone="verdict-flaky"
      label="Not verified read-only"
      icon={ShieldAlert}
      {...props}
    />
  );
}

export function LanguageBadge({ language }: { language: OracleLanguage }) {
  return <Badge variant="outline">{LANGUAGE_LABELS[language]}</Badge>;
}
