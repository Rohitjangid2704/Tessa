import { FileWarning, ListChecks, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { runRoutes, scenarioRoutes } from "@/lib/routes";
import { pluralize } from "../format";
import type { BundleUploadResult } from "../bundle-requests";

export interface ScenarioImportSummaryProps {
  bundle: BundleUploadResult["bundle"];
  dryRunRunId: string | null;
}

const SCENARIO_FILE_PREFIX = "scenarios/";
export const DRY_RUN_SKIPPED_CODE = "dry_run_skipped";

type ImportWarning = BundleUploadResult["bundle"]["warnings"][number];

function describeLocation(warning: ImportWarning): string {
  const parts = [warning.file];
  if (warning.line !== null && warning.line !== undefined) {
    parts.push(`line ${warning.line}`);
  }
  return parts.join(", ");
}

export function ScenarioImportSummary({ bundle, dryRunRunId }: ScenarioImportSummaryProps) {
  const fileWarnings = bundle.warnings.filter(
    (warning) =>
      warning.file.startsWith(SCENARIO_FILE_PREFIX) && warning.code !== DRY_RUN_SKIPPED_CODE,
  );
  const dryRunSkipped = bundle.warnings.some((warning) => warning.code === DRY_RUN_SKIPPED_CODE);
  const imported = bundle.scenarios_imported;
  if (imported === 0 && fileWarnings.length === 0 && !dryRunSkipped) {
    return null;
  }

  return (
    <section
      aria-label="Authored scenarios"
      data-slot="scenario-import-summary"
      className="flex flex-col gap-3 rounded-lg border p-3"
    >
      <div className="flex items-start gap-2">
        <ListChecks aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-col gap-1 text-sm">
          <h4 className="font-medium">
            {imported === 0
              ? "No authored scenario was imported"
              : `${pluralize(imported, "authored scenario")} imported`}
          </h4>
          <p className="text-muted-foreground">
            {imported === 0
              ? "The scenario files of this bundle were all rejected, see the warnings below."
              : "They wait in the review queue until a person accepts them."}
          </p>
        </div>
      </div>
      {dryRunRunId === null ? (
        imported > 0 ? (
          <p
            data-slot="dry-run-note"
            className="flex items-start gap-2 text-sm text-muted-foreground"
          >
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {dryRunSkipped
              ? "dry_run_skipped: this target is on tier production, so the scenarios were not dry-run and stay in review."
              : "No dry run was started for these scenarios."}
          </p>
        ) : null
      ) : (
        <p data-slot="dry-run-note" className="text-sm text-muted-foreground">
          A generate run dry-runs the imported scenarios in the background.
        </p>
      )}
      {fileWarnings.length === 0 ? null : (
        <ul aria-label="Scenario file warnings" className="flex flex-col gap-1.5 text-sm">
          {fileWarnings.map((warning, index) => (
            <li
              key={`${warning.file}:${warning.code}:${index}`}
              className="flex items-start gap-2"
            >
              <FileWarning aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
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
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <Link href={scenarioRoutes.review()}>Open the review queue</Link>
        </Button>
        {dryRunRunId === null ? null : (
          <Button asChild variant="outline" size="sm">
            <Link href={runRoutes.detail(dryRunRunId)}>Watch the dry runs</Link>
          </Button>
        )}
      </div>
    </section>
  );
}
