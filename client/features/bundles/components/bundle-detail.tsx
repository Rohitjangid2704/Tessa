"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Info } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { DateTime } from "@/components/date-time";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { describeApiError, isApiError } from "@/lib/api/errors";
import type { Bundle } from "@/lib/api/types";
import { useCanDo } from "@/lib/auth/can";
import { formatBytes } from "@/lib/format-bytes";
import { targetRoutes } from "@/lib/routes";
import { describeSource, pluralize, shortHash } from "../format";
import { bundleDetailQuery } from "../queries";
import { BundleDiffView, DEFAULT_AGAINST } from "./bundle-diff-view";
import { CompletenessBadge, ValidationBadge } from "./bundle-badges";
import { BundleSourceChips } from "./bundle-source-chips";
import { CompletenessPanel } from "./completeness-panel";
import { FilePreview } from "./file-preview";
import { FixupPromptDialog } from "./fixup-prompt-dialog";
import { ValidationErrors } from "./validation-errors";

export const VIEWER_FIXUP_REASON = "Viewers can read bundles but cannot generate prompts.";

export function hasOpenItems(bundle: Bundle): boolean {
  return (
    bundle.errors.length > 0 ||
    bundle.warnings.length > 0 ||
    bundle.completeness.checks.some((check) => !check.passed)
  );
}

export function needsFixup(bundle: Bundle): boolean {
  return bundle.validation_status === "invalid" || bundle.completeness.status === "below_bar";
}

function describeComparison(bundle: Bundle): string {
  const summary = bundle.diff_summary;
  if (summary === null) {
    return "First version, nothing to compare with";
  }
  const base =
    summary.against_version === null || summary.against_version === undefined
      ? "the previous valid version"
      : `version ${summary.against_version}`;
  return `Against ${base}: ${summary.features_added} added, ${summary.features_removed} removed, ${summary.features_changed} changed`;
}

function DetailSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-6">
      <span className="sr-only">Loading the bundle</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

function BackLink({ targetId }: { targetId: string }) {
  return (
    <Button asChild variant="outline">
      <Link href={targetRoutes.bundles(targetId)}>
        <ArrowLeft aria-hidden="true" data-icon="inline-start" />
        All versions
      </Link>
    </Button>
  );
}

function BundleHeader({ bundle, targetId }: { bundle: Bundle; targetId: string }) {
  const headingId = useId();
  const issue = useCanDo("prompts.issue");
  const readOnly = !issue.isPending && !issue.allowed;
  const open = hasOpenItems(bundle);
  const valid = bundle.validation_status === "valid";

  return (
    <section aria-labelledby={headingId} data-slot="bundle-summary" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={headingId} className="text-xl font-semibold">
              Version {bundle.version}
            </h2>
            <ValidationBadge status={bundle.validation_status} />
            <CompletenessBadge status={bundle.completeness.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {describeSource(bundle.source)}, uploaded <DateTime value={bundle.uploaded_at} />
          </p>
          <BundleSourceChips bundle={bundle} />
          {bundle.note ? <p className="text-sm">Note: {bundle.note}</p> : null}
        </div>
        {open ? (
          <FixupPromptDialog
            targetId={targetId}
            bundleId={bundle.id}
            bundleVersion={bundle.version}
            primary={needsFixup(bundle)}
            disabled={issue.isPending}
            disabledReason={readOnly ? VIEWER_FIXUP_REASON : null}
          />
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Info aria-hidden="true" className="size-4" />
            Nothing is open: no errors, no warnings and every check earned full credit.
          </p>
        )}
      </div>
      <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col">
          <dt className="text-muted-foreground">Content</dt>
          <dd>
            {pluralize(bundle.feature_count, "feature")}, {pluralize(bundle.file_count, "file")},{" "}
            {formatBytes(bundle.size_bytes)}
          </dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-muted-foreground">Hash</dt>
          <dd>
            <code className="font-mono text-xs" title={bundle.hash}>
              {shortHash(bundle.hash)}
            </code>
          </dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-muted-foreground">Schema version</dt>
          <dd>{bundle.schema_version}</dd>
        </div>
        <div className="flex flex-col" data-slot="comparison">
          <dt className="text-muted-foreground">Comparison</dt>
          <dd>{describeComparison(bundle)}</dd>
        </div>
      </dl>
      <div className="flex flex-wrap items-center gap-3">
        <BackLink targetId={targetId} />
        {valid ? (
          <Button asChild variant="outline">
            <Link href={targetRoutes.catalog(targetId)}>View the catalog</Link>
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            No catalog was built from this version because it is invalid.
          </p>
        )}
      </div>
    </section>
  );
}

function HooksMissing({ hooks }: { hooks: Bundle["hooks_missing"] }) {
  const headingId = useId();
  if (hooks.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-lg font-semibold">
          Missing test hooks
        </h2>
        <p className="text-sm text-muted-foreground">
          For information only. The app does not offer these hooks yet. The Hooks prompt on the
          Mutation page asks Claude Code to add them.
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        {hooks.map((hook) => (
          <li key={hook.id} className="flex flex-col rounded-lg border p-3 text-sm">
            <code className="font-mono text-xs">{hook.id}</code>
            <span>{hook.description}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface BundleDetailProps {
  targetId: string;
  bundleId: string;
  against?: string | null;
}

export function BundleDetail({ targetId, bundleId, against = null }: BundleDetailProps) {
  const query = useQuery(bundleDetailQuery(bundleId));

  if (query.isPending) {
    return <DetailSkeleton />;
  }

  if (query.isError) {
    const missing = isApiError(query.error) && query.error.status === 404;
    return (
      <div className="flex flex-col items-start gap-4">
        <ErrorState
          title={missing ? "Bundle not found" : "Could not load the bundle"}
          description={
            missing
              ? "This version does not exist, or it was removed."
              : describeApiError(query.error)
          }
          requestId={readRequestId(query.error)}
          onRetry={missing ? undefined : () => void query.refetch()}
          className="w-full"
        />
        <BackLink targetId={targetId} />
      </div>
    );
  }

  const bundle = query.data;

  if (bundle.target_id !== targetId) {
    return (
      <div className="flex flex-col items-start gap-4">
        <ErrorState
          title="This version belongs to another target"
          description="The link mixes a target with a bundle of a different target."
          className="w-full"
        />
        <Button asChild variant="outline">
          <Link href={targetRoutes.bundle(bundle.target_id, bundle.id)}>
            Open it under its own target
          </Link>
        </Button>
      </div>
    );
  }

  const invalid = bundle.validation_status === "invalid";
  const problems = <ValidationErrors errors={bundle.errors} warnings={bundle.warnings} />;
  const completeness = (
    <CompletenessPanel
      completeness={bundle.completeness}
      validationStatus={bundle.validation_status}
    />
  );

  return (
    <div
      data-slot="bundle-detail"
      data-validation={bundle.validation_status}
      className="flex flex-col gap-10"
    >
      <BundleHeader bundle={bundle} targetId={targetId} />
      {invalid ? (
        <>
          {problems}
          {completeness}
        </>
      ) : (
        <>
          {completeness}
          {problems}
        </>
      )}
      <HooksMissing hooks={bundle.hooks_missing} />
      <BundleDiffView key={against ?? DEFAULT_AGAINST} bundle={bundle} initialAgainst={against} />
      <FilePreview bundleId={bundle.id} />
    </div>
  );
}
