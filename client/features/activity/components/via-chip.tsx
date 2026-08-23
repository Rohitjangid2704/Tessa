import { Bot, Globe, KeyRound, type LucideIcon } from "lucide-react";
import { StatusBadge } from "@/components/status/status-badge";
import type { Tone } from "@/components/status/tones";
import type { AuditVia } from "@/lib/api/types";
import { AUDIT_VIA_LABELS } from "../labels";

const VIA_TONES: Record<AuditVia, Tone> = {
  web: "hollow",
  mcp: "tier-laya",
  svc: "tier-code",
};

const VIA_ICONS: Record<AuditVia, LucideIcon> = {
  web: Globe,
  mcp: Bot,
  svc: KeyRound,
};

export function ViaChip({ via }: { via: AuditVia }) {
  return (
    <StatusBadge
      data-via={via}
      tone={VIA_TONES[via]}
      label={AUDIT_VIA_LABELS[via]}
      icon={VIA_ICONS[via]}
    />
  );
}
