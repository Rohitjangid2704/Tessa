"use client";

import { CircleCheck, Info, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { targetRoutes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/format-bytes";
import { pluralize } from "../format";
import type { BundleUploadResult } from "../bundle-requests";
import type { IntakeOutcome } from "../use-bundle-intake";
import type { UploadFailure } from "../upload-errors";
import { CompletenessBadge, ValidationBadge } from "./bundle-badges";
import { MutantImportSummary } from "./mutant-import-summary";
import { ScenarioImportSummary } from "./scenario-import-summary";

const MAX_LISTED_PROBLEMS = 8;

type Bundle = BundleUploadResult["bundle"];

function describeDiffSummary(bundle: Bundle): string {
  const summary = bundle.diff_summary;
  if (summary === null) {
    return "First version, so there is nothing to compare with.";
  }
  const base =
    summary.against_version === null || summary.against_version === undefined
      ? "the previous valid version"
      : `version ${summary.against_version}`;
  return `Compared with ${base}: ${summary.features_added} added, ${summary.features_removed} removed, ${summary.features_changed} changed.`;
}

function headline(outcome: Extract<IntakeOutcome, { result: BundleUploadResult }>): {
  title: string;
  description: string;
} {
  const { bundle } = outcome.result;
  if (outcome.kind === "identical") {
    return {
      title: `Identical to version ${bundle.version}`,
      description: "This exact content is already stored, so nothing new was created.",
    };
  }
  if (bundle.validation_status === "invalid") {
    return {
      title: `Version ${bundle.version} stored with errors`,
      description:
        "The bundle did not validate, so no catalog was built. Open it to read the errors and generate a Fix-up prompt.",
    };
  }
  if (bundle.completeness.status === "below_bar") {
    return {
      title: `Version ${bundle.version} created`,
      description:
        "The bundle is valid but below the completeness bar. Open it to see which checks lost points.",
    };
  }
  return {
    title: `Version ${bundle.version} created`,
    description: "The bundle is valid and meets the completeness bar.",
  };
}

export interface UploadSuccessProps {
  outcome: Extract<IntakeOutcome, { result: BundleUploadResult }>;
  targetId: string;
  onDismiss: () => void;
}

export function UploadSuccess({ outcome, targetId, onDismiss }: UploadSuccessProps) {
  const { bundle } = outcome.result;
  const { title, description } = headline(outcome);
  const identical = outcome.kind === "identical";
  const Icon = identical ? Info : CircleCheck;

  return (
    <section
      aria-label="Upload result"
      data-outcome={outcome.kind}
      className="flex flex-col gap-3 rounded-xl border p-4"
    >
      <div className="flex items-start gap-3">
        <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-base font-semibold">{title}</h3>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ValidationBadge status={bundle.validation_status} />
        <CompletenessBadge status={bundle.completeness.status} />
        <span className="text-sm">
          Score {bundle.completeness.score} of 100, bar {bundle.completeness.bar}
        </span>
      </div>
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Content</dt>
          <dd>
            {pluralize(bundle.feature_count, "feature")}, {pluralize(bundle.file_count, "file")},{" "}
            {formatBytes(bundle.size_bytes)}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Issues</dt>
          <dd>
            {pluralize(bundle.errors.length, "error")},{" "}
            {pluralize(bundle.warnings.length, "warning")}
          </dd>
        </div>
        <div className="flex gap-2 sm:col-span-2">
          <dt className="text-muted-foreground">Diff</dt>
          <dd>{describeDiffSummary(bundle)}</dd>
        </div>
      </dl>
      <ScenarioImportSummary bundle={bundle} dryRunRunId={outcome.result.dry_run_run_id} />
      <MutantImportSummary bundle={bundle} />
      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <Link href={targetRoutes.bundle(targetId, bundle.id)}>Open version {bundle.version}</Link>
        </Button>
        {bundle.validation_status === "valid" ? (
          <Button asChild variant="outline">
            <Link href={targetRoutes.catalog(targetId)}>View the catalog</Link>
          </Button>
        ) : null}
        <Button type="button" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </section>
  );
}

export interface UploadFailureAlertProps {
  failure: UploadFailure;
  sourceName: string | null;
  onDismiss?: () => void;
  className?: string;
}

export function UploadFailureAlert({
  failure,
  sourceName,
  onDismiss,
  className,
}: UploadFailureAlertProps) {
  const listedProblems = failure.problems.slice(0, MAX_LISTED_PROBLEMS);
  const hiddenProblems = failure.problems.length - listedProblems.length;
  const showProblems = failure.kind !== "secret_found" && listedProblems.length > 1;

  return (
    <section
      role="alert"
      aria-label="Upload failed"
      data-failure={failure.kind}
      data-code={failure.code}
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-destructive/30 p-4 text-left",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-destructive" />
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-base font-semibold">{failure.title}</h3>
          {sourceName === null ? null : (
            <p className="text-xs text-muted-foreground">Source: {sourceName}</p>
          )}
          <p className="text-sm">{failure.message}</p>
          {failure.nextStep === null ? null : (
            <p className="text-sm text-muted-foreground">{failure.nextStep}</p>
          )}
        </div>
      </div>
      {failure.findings.length === 0 ? null : (
        <div className="overflow-x-auto rounded-lg border">
          <Table aria-label="Secrets found">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>File</TableHead>
                <TableHead>Line</TableHead>
                <TableHead>Pattern</TableHead>
                <TableHead>Redacted excerpt</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {failure.findings.map((finding, index) => (
                <TableRow key={`${finding.file}:${finding.line}:${finding.pattern}:${index}`}>
                  <TableCell className="font-mono text-xs">{finding.file}</TableCell>
                  <TableCell>{finding.line ?? "unknown"}</TableCell>
                  <TableCell className="font-mono text-xs">{finding.pattern}</TableCell>
                  <TableCell className="font-mono text-xs break-all whitespace-normal">
                    {finding.excerpt}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {showProblems ? (
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
          {listedProblems.map((problem, index) => (
            <li key={`${problem.code}:${problem.path}:${index}`}>
              <span className="font-mono text-xs">{problem.code}</span>: {problem.message}
            </li>
          ))}
          {hiddenProblems > 0 ? <li>and {hiddenProblems} more</li> : null}
        </ul>
      ) : null}
      {failure.requestId === null ? null : (
        <p className="font-mono text-xs text-muted-foreground">Request ID: {failure.requestId}</p>
      )}
      {onDismiss === undefined ? null : (
        <div>
          <Button type="button" variant="outline" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      )}
    </section>
  );
}

export interface IntakeOutcomeViewProps {
  outcome: IntakeOutcome;
  targetId: string;
  onDismiss: () => void;
}

export function IntakeOutcomeView({ outcome, targetId, onDismiss }: IntakeOutcomeViewProps) {
  if (outcome.kind === "failed") {
    return (
      <UploadFailureAlert
        failure={outcome.failure}
        sourceName={outcome.sourceName}
        onDismiss={onDismiss}
      />
    );
  }
  return <UploadSuccess outcome={outcome} targetId={targetId} onDismiss={onDismiss} />;
}
