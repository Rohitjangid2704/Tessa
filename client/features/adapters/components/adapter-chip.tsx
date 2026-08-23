import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { describeAdapterKind } from "../registry";

export interface AdapterChipProps {
  kind: string;
  label?: string;
  mono?: boolean;
  className?: string;
}

interface AdapterBadgeProps {
  kind: string;
  icon: LucideIcon;
  text: string;
  hiddenText: string | null;
  mono: boolean;
  className: string | undefined;
}

function AdapterBadge({ kind, icon: Icon, text, hiddenText, mono, className }: AdapterBadgeProps) {
  return (
    <Badge
      variant="outline"
      data-slot="adapter-chip"
      data-adapter-kind={kind}
      className={cn(mono && "font-mono", className)}
    >
      <Icon aria-hidden="true" />
      {text}
      {hiddenText === null ? null : <span className="sr-only">{hiddenText}</span>}
    </Badge>
  );
}

export function AdapterChip({ kind, label, mono = false, className }: AdapterChipProps) {
  const entry = describeAdapterKind(kind);
  return (
    <AdapterBadge
      kind={kind}
      icon={entry.icon}
      text={label ?? entry.label}
      hiddenText={label === undefined ? null : `, ${entry.label} interface`}
      mono={mono}
      className={className}
    />
  );
}
