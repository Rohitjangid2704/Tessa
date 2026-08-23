import { CopyButton } from "@/components/copy-button";
import { ConfidenceChip } from "@/features/catalog/components/confidence-chip";
import type { ExplanationFile, ExplanationStructured } from "@/lib/api/types";
import { ExplanationOpinionBadge } from "./explanation-opinion-badge";

export type StructuredExplanationCardProps = {
  structured: ExplanationStructured;
};

export function formatStructuredFile(file: ExplanationFile): string {
  return file.lines ? `${file.path}:${file.lines}` : file.path;
}

function CopyableValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1">
        <span className="font-mono text-xs wrap-anywhere">{value}</span>
        <CopyButton text={value} subject={label.toLowerCase()} variant="ghost" size="xs" />
      </dd>
    </div>
  );
}

export function StructuredExplanationCard({ structured }: StructuredExplanationCardProps) {
  const commit = structured.commit ?? null;
  const fixBranch = structured.fix_branch ?? null;
  const files = structured.files ?? [];

  return (
    <div
      data-slot="structured-explanation"
      data-opinion={structured.opinion}
      className="flex flex-col gap-3 rounded-md border bg-muted/30 px-3 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ExplanationOpinionBadge opinion={structured.opinion} />
        <ConfidenceChip confidence={structured.confidence} />
      </div>
      <div className="flex flex-col gap-1">
        <h4 className="text-xs font-medium text-muted-foreground">Root cause</h4>
        <p className="text-sm wrap-anywhere whitespace-pre-wrap">{structured.root_cause}</p>
      </div>
      <div className="flex flex-col gap-1">
        <h4 className="text-xs font-medium text-muted-foreground">Files ({files.length})</h4>
        {files.length === 0 ? (
          <p className="text-sm text-muted-foreground">No files named.</p>
        ) : (
          <ul
            aria-label="Files"
            tabIndex={0}
            className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-md border bg-background px-2 py-1.5"
          >
            {files.map((file, index) => (
              <li key={`${index}:${formatStructuredFile(file)}`}>
                <code className="font-mono text-xs wrap-anywhere">
                  {formatStructuredFile(file)}
                </code>
              </li>
            ))}
          </ul>
        )}
      </div>
      {commit === null && fixBranch === null ? null : (
        <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          {commit === null ? null : <CopyableValue label="Commit" value={commit} />}
          {fixBranch === null ? null : <CopyableValue label="Fix branch" value={fixBranch} />}
        </dl>
      )}
    </div>
  );
}
