import { FileWarning, FlaskConical } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { mutationRoutes } from "@/lib/routes";
import { pluralize } from "../format";
import type { BundleUploadResult } from "../bundle-requests";

export interface MutantImportSummaryProps {
  bundle: BundleUploadResult["bundle"];
}

const MUTANTS_FILE_SUFFIX = "mutants.yaml";

type ImportWarning = BundleUploadResult["bundle"]["warnings"][number];

function describeLocation(warning: ImportWarning): string {
  const parts = [warning.file];
  if (warning.line !== null && warning.line !== undefined) {
    parts.push(`line ${warning.line}`);
  }
  return parts.join(", ");
}

export function MutantImportSummary({ bundle }: MutantImportSummaryProps) {
  const fileWarnings = bundle.warnings.filter((warning) =>
    warning.file.endsWith(MUTANTS_FILE_SUFFIX),
  );
  const imported = bundle.mutants_imported;
  if (imported === 0 && fileWarnings.length === 0) {
    return null;
  }

  return (
    <section
      aria-label="Imported mutants"
      data-slot="mutant-import-summary"
      className="flex flex-col gap-3 rounded-lg border p-3"
    >
      <div className="flex items-start gap-2">
        <FlaskConical aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-col gap-1 text-sm">
          <h4 className="font-medium">
            {imported === 0
              ? "No mutant was imported"
              : `${pluralize(imported, "mutant")} imported`}
          </h4>
          <p className="text-muted-foreground">
            {imported === 0
              ? "The entries of tessa/mutants.yaml were all rejected, see the warnings below."
              : "They are registered but not deployed. Deploy each branch to QA, mark it deployed on the mutation page and run it."}
          </p>
        </div>
      </div>
      {fileWarnings.length === 0 ? null : (
        <ul aria-label="Mutant file warnings" className="flex flex-col gap-1.5 text-sm">
          {fileWarnings.map((warning, index) => (
            <li key={`${warning.file}:${warning.code}:${index}`} className="flex items-start gap-2">
              <FileWarning
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0">
                <span className="font-mono text-xs">{describeLocation(warning)}</span>
                <span className="block">
                  <span className="font-mono text-xs">{warning.code}</span>: {warning.message}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button asChild variant="outline" size="sm">
          <Link href={mutationRoutes.list(bundle.target_id)}>Open the mutation page</Link>
        </Button>
      </div>
    </section>
  );
}
