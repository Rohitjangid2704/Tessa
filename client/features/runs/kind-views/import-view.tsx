"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Circle, CircleCheck, CircleX, LoaderCircle, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useId } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CompletenessBadge, ValidationBadge } from "@/features/bundles/components/bundle-badges";
import { shortHash } from "@/features/bundles/format";
import { UPSTREAM_ERROR_CODE } from "@/features/bundles/pull-errors";
import { bundleDetailQuery } from "@/features/bundles/queries";
import { describeApiError } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import { libraryRoutes, targetRoutes } from "@/lib/routes";
import { useThrottledValue } from "@/lib/use-throttled-value";
import { EventLog } from "../components/event-log";
import {
  deriveImportProgress,
  type ImportFailure,
  type ImportStage,
  type ImportStageState,
} from "../import-progress";
import { isTerminalRunStatus } from "../run-status";
import { useRunEvents, useRunStreamState } from "../use-run-stream";

const ANNOUNCE_INTERVAL_MS = 2000;

const STAGE_STATE_TEXT: Record<ImportStageState, string> = {
  pending: "Waiting",
  active: "In progress",
  done: "Done",
  failed: "Stopped here",
};

function StageIcon({ state }: { state: ImportStageState }) {
  if (state === "done") {
    return <CircleCheck aria-hidden="true" className="size-5 text-muted-foreground" />;
  }
  if (state === "active") {
    return <LoaderCircle aria-hidden="true" className="size-5 animate-spin" />;
  }
  if (state === "failed") {
    return <CircleX aria-hidden="true" className="size-5 text-destructive" />;
  }
  return <Circle aria-hidden="true" className="size-5 text-muted-foreground" />;
}

function StageRow({ stage }: { stage: ImportStage }) {
  return (
    <li
      data-stage={stage.id}
      data-state={stage.state}
      aria-current={stage.state === "active" ? "step" : undefined}
      className="flex items-start gap-3"
    >
      <StageIcon state={stage.state} />
      <div className="flex min-w-0 flex-col">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {stage.label}
          <span className="text-xs font-normal text-muted-foreground">
            {STAGE_STATE_TEXT[stage.state]}
          </span>
        </span>
        {stage.detail === null ? null : (
          <span className="text-sm wrap-break-word text-muted-foreground">{stage.detail}</span>
        )}
      </div>
    </li>
  );
}

function FailureAlert({ failure }: { failure: ImportFailure }) {
  const title =
    failure.code === UPSTREAM_ERROR_CODE
      ? "Git could not deliver the repository"
      : "The import failed";
  return (
    <Alert variant="destructive" data-slot="import-failure" data-code={failure.code ?? undefined}>
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        {failure.code === null ? null : (
          <code className="mr-2 rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">
            {failure.code}
          </code>
        )}
        <span className="wrap-break-word">{failure.message}</span>
      </AlertDescription>
    </Alert>
  );
}

function CreatedBundle({ targetId, bundleId }: { targetId: string; bundleId: string }) {
  const query = useQuery(bundleDetailQuery(bundleId));

  if (query.isPending) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-2">
        <span className="sr-only">Loading the created bundle</span>
        <Skeleton className="h-5 w-56" />
      </div>
    );
  }

  const bundle = query.data;
  return (
    <div data-slot="import-result" className="flex flex-col gap-3">
      {bundle === undefined ? (
        <p className="text-sm text-muted-foreground">
          The pull created a bundle, but its details could not be loaded:{" "}
          {describeApiError(query.error)}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">Version {bundle.version} created</span>
          <ValidationBadge status={bundle.validation_status} />
          <CompletenessBadge status={bundle.completeness.status} />
          <code className="font-mono text-xs text-muted-foreground" title={bundle.hash}>
            {shortHash(bundle.hash)}
          </code>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild>
          <Link href={targetRoutes.bundle(targetId, bundleId)}>Open the created bundle</Link>
        </Button>
        {bundle?.validation_status === "valid" ? (
          <Button asChild variant="outline">
            <Link href={targetRoutes.catalog(targetId)}>View the catalog</Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export type ImportViewProps = { runId: string };

export function ImportView({ runId }: ImportViewProps) {
  const headingId = useId();
  const queryClient = useQueryClient();
  const { run } = useRunStreamState();
  const { events } = useRunEvents();
  const status = run?.status ?? "queued";
  const targetId = run?.target_id ?? null;
  const bundleId = run?.bundle_id ?? null;
  const terminal = isTerminalRunStatus(status);
  const progress = deriveImportProgress(status, events);
  const announced = useThrottledValue(progress.summary, ANNOUNCE_INTERVAL_MS);

  useEffect(() => {
    if (!terminal) {
      return;
    }
    void queryClient.invalidateQueries({ queryKey: qk.runs.detail(runId) });
    void queryClient.invalidateQueries({ queryKey: qk.library.all() });
    void queryClient.invalidateQueries({ queryKey: qk.targets.all() });
    void queryClient.invalidateQueries({ queryKey: qk.catalogRoot() });
    if (targetId !== null) {
      void queryClient.invalidateQueries({ queryKey: qk.bundleSource(targetId) });
    }
  }, [terminal, runId, targetId, queryClient]);

  return (
    <div data-slot="import-view" data-status={status} className="flex flex-col gap-6">
      <section aria-labelledby={headingId} className="flex flex-col gap-4 rounded-xl border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id={headingId} className="text-base font-semibold">
            Import from git
          </h2>
          {targetId === null ? null : (
            <Button asChild variant="outline" size="sm">
              <Link href={libraryRoutes.list({ target_id: targetId })}>Git source settings</Link>
            </Button>
          )}
        </div>
        <ol aria-label="Import progress" className="flex flex-col gap-3">
          {progress.stages.map((stage) => (
            <StageRow key={stage.id} stage={stage} />
          ))}
        </ol>
        {progress.failure === null ? null : <FailureAlert failure={progress.failure} />}
        {status === "completed" && targetId !== null ? (
          bundleId === null ? (
            <p data-slot="import-no-bundle" className="text-sm text-muted-foreground">
              The pull finished but reported no bundle. Check the{" "}
              <Link
                href={targetRoutes.bundles(targetId)}
                className="font-medium underline underline-offset-4"
              >
                versions of this target
              </Link>
              .
            </p>
          ) : (
            <CreatedBundle targetId={targetId} bundleId={bundleId} />
          )
        ) : null}
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {announced}
        </div>
      </section>
      <EventLog runId={runId} />
    </div>
  );
}
