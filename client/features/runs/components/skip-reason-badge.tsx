import {
  Ban,
  DatabaseZap,
  ShieldAlert,
  TriangleAlert,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { StatusBadge } from "@/components/status/status-badge";
import type { Tone } from "@/components/status/tones";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { SkipReason } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { describeSkipReason } from "../skip-reasons";

interface LoudPresentation {
  tone: Tone;
  icon: LucideIcon;
}

const LOUD_PRESENTATION: Partial<Record<SkipReason, LoudPresentation>> = {
  budget_exceeded: { tone: "verdict-flaky", icon: Wallet },
  production_blocked: { tone: "verdict-flaky", icon: ShieldAlert },
  seed_mismatch: { tone: "verdict-fail", icon: DatabaseZap },
};

export interface SkipReasonProps {
  reason: SkipReason;
  adapterKind?: string | null;
}

export function SkipReasonBadge({ reason, adapterKind }: SkipReasonProps) {
  const text = describeSkipReason(reason, adapterKind);
  const loud = LOUD_PRESENTATION[reason];
  return (
    <StatusBadge
      tone={loud?.tone ?? "hollow"}
      icon={loud?.icon ?? Ban}
      label={text.label}
      data-slot="skip-reason-badge"
      data-skip-reason={reason}
      data-loud={text.loud ? "true" : "false"}
      title={text.explanation}
      className={cn(text.loud && "font-semibold ring-1 ring-current/40")}
    />
  );
}

export function SkipReasonNotice({ reason, adapterKind }: SkipReasonProps) {
  const text = describeSkipReason(reason, adapterKind);
  if (text.loud) {
    return (
      <Alert
        variant="destructive"
        role="note"
        data-slot="skip-reason-notice"
        data-skip-reason={reason}
        data-loud="true"
      >
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>Skipped: {text.label}</AlertTitle>
        <AlertDescription>{text.explanation}</AlertDescription>
      </Alert>
    );
  }
  return (
    <p
      data-slot="skip-reason-notice"
      data-skip-reason={reason}
      data-loud="false"
      className="text-sm text-muted-foreground"
    >
      <span className="font-medium text-foreground">Skipped: {text.label}.</span>{" "}
      {text.explanation}
    </p>
  );
}
