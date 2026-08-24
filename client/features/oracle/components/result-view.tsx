"use client";

import { useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { DateTime } from "@/components/date-time";
import { readRequestId } from "@/components/states/request-id";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { pluralize } from "@/features/bundles/format";
import { describeApiError, isApiError } from "@/lib/api/errors";
import { oracleResultQuery } from "../queries";
import type { OracleResult } from "../types";
import { ResultStatusBadge } from "./oracle-badges";
import { RowsTable } from "./rows-table";
import { SentenceCard } from "./sentence-card";

export function useShownResult(resultId: string | null, templateId: string) {
  const query = useQuery({ ...oracleResultQuery(resultId ?? ""), enabled: resultId !== null });
  const result =
    query.data !== undefined && query.data.oracle_template_id === templateId
      ? query.data
      : undefined;
  return {
    query,
    result,
    belongsToAnotherTemplate: query.data !== undefined && result === undefined,
  };
}

export type ShownResult = ReturnType<typeof useShownResult>;

export function describeResultAnnouncement(result: OracleResult): string {
  if (result.status === "pending") {
    return "The query is running.";
  }
  if (result.status === "error") {
    return "The query failed.";
  }
  return `The query finished with ${pluralize(result.rows.length, "row")}.`;
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) {
    return "not finished";
  }
  return durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)} s` : `${durationMs} ms`;
}

function ResultMeta({ result }: { result: OracleResult }) {
  return (
    <dl
      data-slot="result-meta"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground"
    >
      <div className="flex items-center gap-1.5">
        <dt className="sr-only">Status</dt>
        <dd>
          <ResultStatusBadge status={result.status} />
        </dd>
      </div>
      <div className="flex gap-1">
        <dt>Duration</dt>
        <dd className="font-medium text-foreground tabular-nums">
          {formatDuration(result.duration_ms)}
        </dd>
      </div>
      <div className="flex gap-1">
        <dt>Finished</dt>
        <dd className="font-medium text-foreground">
          <DateTime value={result.executed_at} fallback="not yet" />
        </dd>
      </div>
      <div className="flex min-w-0 gap-1">
        <dt>Parameters</dt>
        <dd className="min-w-0 font-mono text-xs break-all text-foreground">
          {JSON.stringify(result.params)}
        </dd>
      </div>
    </dl>
  );
}

export interface ResultViewProps {
  resultId: string | null;
  shown: ShownResult;
}

export function ResultView({ resultId, shown }: ResultViewProps) {
  const { query, result, belongsToAnotherTemplate } = shown;

  if (resultId === null) {
    return (
      <p
        data-slot="result-empty"
        className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground"
      >
        Run the query to see its rows and the expected sentence here.
      </p>
    );
  }

  if (query.isPending) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-3">
        <span className="sr-only">Loading the result</span>
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (query.isError) {
    const missing = isApiError(query.error) && query.error.status === 404;
    return (
      <Alert variant="destructive">
        <AlertTitle>{missing ? "Result not found" : "Could not load the result"}</AlertTitle>
        <AlertDescription>
          <p>
            {missing
              ? "This result does not exist. Run the query again."
              : describeApiError(query.error)}
            {readRequestId(query.error) === null
              ? null
              : ` Request ID: ${readRequestId(query.error)}`}
          </p>
          {missing ? null : (
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void query.refetch()}
            >
              Try again
            </Button>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  if (result === undefined || belongsToAnotherTemplate) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Result not found</AlertTitle>
        <AlertDescription>This result belongs to a different template.</AlertDescription>
      </Alert>
    );
  }

  return (
    <div data-slot="result-view" data-status={result.status} className="flex flex-col gap-4">
      <p role="status" className="sr-only">
        {describeResultAnnouncement(result)}
      </p>
      <ResultMeta result={result} />
      {result.status === "pending" ? (
        <div
          data-slot="result-pending"
          className="flex items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground"
        >
          <LoaderCircle
            aria-hidden="true"
            className="size-4 animate-spin motion-reduce:animate-none"
          />
          Running the query. This page checks again until it finishes.
        </div>
      ) : null}
      {result.status === "error" ? (
        <Alert variant="destructive" data-slot="result-error">
          <AlertTitle>The query failed</AlertTitle>
          <AlertDescription>
            <p className="font-mono text-xs break-words whitespace-pre-wrap">
              {result.error ?? "No error message was reported."}
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
      {result.status === "ok" ? (
        <>
          <SentenceCard sentence={result.sentence} />
          <RowsTable rows={result.rows} truncated={result.rows_truncated} />
        </>
      ) : null}
    </div>
  );
}
