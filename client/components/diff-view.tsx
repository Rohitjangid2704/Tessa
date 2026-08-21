import { useMemo } from "react";
import { countChanges, diffLines, type DiffLine } from "@/lib/line-diff";
import { cn } from "@/lib/utils";

export type DiffViewProps = {
  original: string;
  modified: string;
  originalLabel: string;
  modifiedLabel: string;
  label: string;
  className?: string;
};

const LINE_CLASSES = {
  same: "",
  added: "bg-verdict-pass-bg text-verdict-pass-fg",
  removed: "bg-verdict-fail-bg text-verdict-fail-fg",
} as const satisfies Record<DiffLine["kind"], string>;

const LINE_SIGNS = { same: " ", added: "+", removed: "-" } as const satisfies Record<
  DiffLine["kind"],
  string
>;

const LINE_ANNOUNCEMENTS = {
  same: "",
  added: "Added: ",
  removed: "Removed: ",
} as const satisfies Record<DiffLine["kind"], string>;

function lineKey(line: DiffLine, index: number): string {
  return `${index}-${line.originalLine ?? "x"}-${line.modifiedLine ?? "x"}`;
}

export function DiffView({
  original,
  modified,
  originalLabel,
  modifiedLabel,
  label,
  className,
}: DiffViewProps) {
  const lines = useMemo(() => diffLines(original, modified), [original, modified]);
  const { added, removed } = countChanges(lines);
  const identical = added === 0 && removed === 0;

  return (
    <figure data-slot="diff-view" className={cn("flex min-w-0 flex-col gap-2", className)}>
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{label}</span>
        <span>
          <span aria-hidden="true">- </span>
          {originalLabel}
        </span>
        <span>
          <span aria-hidden="true">+ </span>
          {modifiedLabel}
        </span>
        <span>
          {removed} removed, {added} added
        </span>
      </figcaption>
      {identical ? (
        <p className="rounded-lg border p-3 text-sm text-muted-foreground">
          The two texts are identical.
        </p>
      ) : (
        <ol
          aria-label={label}
          className="max-h-96 overflow-auto rounded-lg border font-mono text-xs leading-5"
        >
          {lines.map((line, index) => (
            <li
              key={lineKey(line, index)}
              data-kind={line.kind}
              className={cn("flex gap-2 px-2", LINE_CLASSES[line.kind])}
            >
              <span aria-hidden="true" className="w-3 shrink-0 select-none">
                {LINE_SIGNS[line.kind]}
              </span>
              <span className="min-w-0 break-words whitespace-pre-wrap">
                <span className="sr-only">{LINE_ANNOUNCEMENTS[line.kind]}</span>
                {line.text === "" ? " " : line.text}
              </span>
            </li>
          ))}
        </ol>
      )}
    </figure>
  );
}
