import {
  ArrowRightLeft,
  ArrowUpDown,
  Minus,
  PencilLine,
  Plus,
  type LucideIcon,
} from "lucide-react";
import { StatusBadge } from "@/components/status/status-badge";
import type { Tone } from "@/components/status/tones";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  compactJson,
  type StructuralChange,
  type StructuralChangeKind,
} from "@/features/contracts/diff-json";
import { cn } from "@/lib/utils";

interface KindPresentation {
  tone: Tone;
  label: string;
  icon: LucideIcon;
}

const KIND_PRESENTATION = {
  added: { tone: "verdict-pass", label: "Added", icon: Plus },
  removed: { tone: "verdict-fail", label: "Removed", icon: Minus },
  type_changed: { tone: "verdict-flaky", label: "Type changed", icon: ArrowRightLeft },
  value_changed: { tone: "verdict-flaky", label: "Value changed", icon: PencilLine },
  reordered: { tone: "verdict-skipped", label: "Reordered", icon: ArrowUpDown },
} as const satisfies Record<StructuralChangeKind, KindPresentation>;

export const STRUCTURAL_VALUE_MAX_CHARS = 160;

export type StructuralDiffProps = {
  changes: readonly StructuralChange[];
  caption: string;
  beforeLabel: string;
  afterLabel: string;
  kindLabels?: Partial<Record<StructuralChangeKind, string>>;
  emptyText?: string;
  className?: string;
};

function ValueCell({ value, type }: { value: unknown; type: string | null }) {
  if (value === undefined || type === null) {
    return <span className="text-muted-foreground">not set</span>;
  }
  return (
    <span className="flex flex-col gap-0.5">
      <code className="font-mono text-xs break-words whitespace-pre-wrap">
        {compactJson(value, STRUCTURAL_VALUE_MAX_CHARS)}
      </code>
      <span className="text-xs text-muted-foreground">{type}</span>
    </span>
  );
}

export function StructuralDiff({
  changes,
  caption,
  beforeLabel,
  afterLabel,
  kindLabels,
  emptyText = "No structural difference.",
  className,
}: StructuralDiffProps) {
  if (changes.length === 0) {
    return (
      <p data-slot="structural-diff" data-empty="true" className="text-sm text-muted-foreground">
        {emptyText}
      </p>
    );
  }

  return (
    <div data-slot="structural-diff" className={cn("min-w-0", className)}>
      <Table>
        <TableCaption className="sr-only">{caption}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Path</TableHead>
            <TableHead scope="col">Change</TableHead>
            <TableHead scope="col">{beforeLabel}</TableHead>
            <TableHead scope="col">{afterLabel}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {changes.map((entry, index) => {
            const presentation = KIND_PRESENTATION[entry.kind];
            return (
              <TableRow key={`${index}:${entry.kind}:${entry.path}`} data-change-kind={entry.kind}>
                <TableHead
                  scope="row"
                  className="h-auto max-w-56 py-2 align-top font-mono text-xs font-normal break-all whitespace-normal"
                >
                  {entry.path}
                </TableHead>
                <TableCell className="align-top">
                  <StatusBadge
                    tone={presentation.tone}
                    label={kindLabels?.[entry.kind] ?? presentation.label}
                    icon={presentation.icon}
                  />
                </TableCell>
                <TableCell className="max-w-72 align-top whitespace-normal">
                  <ValueCell value={entry.before} type={entry.beforeType} />
                </TableCell>
                <TableCell className="max-w-72 align-top whitespace-normal">
                  <ValueCell value={entry.after} type={entry.afterType} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
