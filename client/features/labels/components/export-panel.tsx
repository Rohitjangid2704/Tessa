"use client";

import { useQuery, type UseMutationResult } from "@tanstack/react-query";
import { CircleCheck, Download } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import { RequiresPermission } from "@/components/requires-permission";
import { Meter } from "@/components/meter";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCount } from "@/features/runs/results-format";
import { describeApiError } from "@/lib/api/errors";
import type { LabelStats } from "@/lib/api/types";
import { labelRoutes } from "@/lib/routes";
import {
  describeExportBlocked,
  describeMilestone,
  EXPORT_MILESTONES,
  isExportReady,
  milestoneRatio,
  SUBJECT_TYPE_LABELS,
  type ExportMilestone,
} from "../export-model";
import {
  labelExportStatsQuery,
  useDownloadLabelsExport,
  type LabelsExportResult,
} from "../export-queries";
import { describeAgreement } from "./label-progress";

type DownloadMutation = UseMutationResult<LabelsExportResult, Error, void>;

function ExportLoading() {
  return (
    <div
      role="status"
      aria-busy="true"
      data-slot="label-export-loading"
      className="flex max-w-3xl flex-col gap-3 rounded-xl border p-4"
    >
      <span className="sr-only">Loading label counts</span>
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-2 w-full" />
      <Skeleton className="h-2 w-full" />
      <Skeleton className="h-9 w-40" />
    </div>
  );
}

function MilestoneMeter({ total, milestone }: { total: number; milestone: ExportMilestone }) {
  const reached = total >= milestone.count;
  const progress = describeMilestone(total, milestone);
  return (
    <div
      data-slot="export-milestone"
      data-milestone={milestone.id}
      data-reached={reached ? "true" : "false"}
      className="flex flex-col gap-1.5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm font-medium">
          {milestone.title} at {formatCount(milestone.count)} labels
        </p>
        <p className="text-sm text-muted-foreground tabular-nums">{progress}</p>
      </div>
      <Meter
        value={milestoneRatio(total, milestone.count)}
        label={milestone.meterLabel}
        valueText={progress}
        tone="neutral"
      />
      {reached ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CircleCheck aria-hidden="true" className="size-3.5 shrink-0" />
          {milestone.reachedText}
        </p>
      ) : null}
    </div>
  );
}

function SubjectTypeCounts({ byType }: { byType: LabelStats["by_subject_type"] }) {
  return (
    <dl data-slot="export-by-subject" className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
      {Object.entries(SUBJECT_TYPE_LABELS).map(([type, label]) => (
        <div key={type} className="flex flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="text-sm font-medium tabular-nums">{formatCount(byType[type] ?? 0)}</dd>
        </div>
      ))}
    </dl>
  );
}

function DownloadStatus({ download }: { download: DownloadMutation }) {
  const requestId = readRequestId(download.error);
  return (
    <>
      <div role="status" data-slot="label-export-status" className="text-sm">
        {download.isSuccess ? (
          <p>
            Downloaded <span className="font-mono">{download.data.filename}</span> with{" "}
            {formatCount(download.data.lines)} {download.data.lines === 1 ? "label" : "labels"}.
          </p>
        ) : null}
      </div>
      {download.isError ? (
        <div role="alert" data-slot="label-export-error" className="flex flex-col gap-1 text-sm">
          <p className="font-medium text-destructive">Could not download the export</p>
          <p className="text-muted-foreground">{describeApiError(download.error)}</p>
          {requestId === null ? null : (
            <p className="font-mono text-xs text-muted-foreground">Request ID: {requestId}</p>
          )}
        </div>
      ) : null}
    </>
  );
}

export function ExportPanel() {
  const headingId = useId();
  const blockedId = useId();
  const stats = useQuery(labelExportStatsQuery());
  const download = useDownloadLabelsExport();

  if (stats.isPending) {
    return <ExportLoading />;
  }
  if (stats.isError) {
    return (
      <ErrorState
        title="Could not load the label counts"
        description={describeApiError(stats.error)}
        requestId={readRequestId(stats.error)}
        onRetry={() => void stats.refetch()}
        className="max-w-3xl py-8"
      />
    );
  }

  const total = stats.data.total_human;
  const ready = isExportReady(total);

  return (
    <section
      aria-labelledby={headingId}
      data-slot="label-export"
      data-ready={ready ? "true" : "false"}
      className="flex max-w-3xl flex-col gap-4 rounded-xl border p-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-base font-semibold">
          Label export
        </h2>
        <p className="text-sm text-muted-foreground">
          Every human label as one JSON object per line, split by run into train and held out. It
          is the input for fine-tuning Laya once enough labels exist.
        </p>
      </div>
      <div className="flex flex-col gap-4">
        {EXPORT_MILESTONES.map((milestone) => (
          <MilestoneMeter key={milestone.id} total={total} milestone={milestone} />
        ))}
      </div>
      <p data-slot="label-export-agreement" className="text-sm">
        {describeAgreement(stats.data.agreement_with_machine)}
      </p>
      <SubjectTypeCounts byType={stats.data.by_subject_type} />
      <div className="flex flex-col items-start gap-2">
        <RequiresPermission action="labels.export">
          {({ disabled }) => (
            <Button
              type="button"
              disabled={disabled || !ready || download.isPending}
              aria-describedby={ready ? undefined : blockedId}
              onClick={() => download.mutate()}
              data-slot="label-export-download"
            >
              <Download aria-hidden="true" data-icon="inline-start" />
              {download.isPending ? "Preparing the export" : "Download JSONL"}
            </Button>
          )}
        </RequiresPermission>
        {ready ? null : (
          <p
            id={blockedId}
            data-slot="label-export-blocked"
            className="text-sm text-muted-foreground"
          >
            {describeExportBlocked(total)}{" "}
            <Link
              href={labelRoutes.queue()}
              className="font-medium underline underline-offset-4"
            >
              Open the review queue
            </Link>
          </p>
        )}
        <DownloadStatus download={download} />
        <p className="text-xs text-muted-foreground">
          Fine-tuning Laya on this file happens in the Laya notebook, outside Tessa v1. The file
          holds the graded text, so treat it as sensitive.
        </p>
      </div>
    </section>
  );
}
