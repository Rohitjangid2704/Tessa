"use client";

import { useQuery } from "@tanstack/react-query";
import { Eye, FileText } from "lucide-react";
import { useId, useState } from "react";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { describeApiError, isApiError } from "@/lib/api/errors";
import type { components } from "@/lib/api/schema";
import { formatBytes } from "@/lib/format-bytes";
import { pluralize } from "../format";
import { bundleFileQuery, bundleFilesQuery } from "../queries";

type BundleFileEntry = components["schemas"]["BundleFileEntry"];

export const DEFAULT_PREVIEW_PATH = "manifest.yaml";
export const SHORT_SHA_LENGTH = 12;

export function pickDefaultPreview(files: readonly BundleFileEntry[]): string | null {
  return files.find((file) => file.path === DEFAULT_PREVIEW_PATH)?.path ?? files[0]?.path ?? null;
}

function PreviewPanel({
  bundleId,
  entry,
  headingId,
}: {
  bundleId: string;
  entry: BundleFileEntry;
  headingId: string;
}) {
  const content = useQuery(bundleFileQuery(bundleId, entry.path));

  return (
    <div data-slot="file-preview" className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={headingId} className="font-mono text-sm font-medium break-all">
          {entry.path}
        </h3>
        <span className="text-xs text-muted-foreground">
          {formatBytes(entry.size_bytes)}, sha256{" "}
          <code className="font-mono" title={entry.sha256}>
            {entry.sha256.slice(0, SHORT_SHA_LENGTH)}
          </code>
        </span>
      </div>
      {content.isPending ? (
        <div role="status" aria-busy="true" className="flex flex-col gap-2">
          <span className="sr-only">Loading {entry.path}</span>
          <Skeleton className="h-4 w-64 max-w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : content.isError ? (
        <ErrorState
          title={
            isApiError(content.error) && content.error.status === 404
              ? "This file has no preview"
              : "Could not load the file"
          }
          description={describeApiError(content.error)}
          requestId={readRequestId(content.error)}
          onRetry={() => void content.refetch()}
          className="py-8"
        />
      ) : (
        <>
          {content.data.truncated ? (
            <p
              role="note"
              data-slot="truncated-notice"
              className="rounded-md bg-verdict-flaky-bg px-2 py-1.5 text-xs text-verdict-flaky-fg"
            >
              This preview is truncated. The stored file is {formatBytes(entry.size_bytes)}; only
              the first part is shown.
            </p>
          ) : null}
          <pre
            tabIndex={0}
            aria-labelledby={headingId}
            className="max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre"
          >
            {content.data.content}
          </pre>
        </>
      )}
    </div>
  );
}

export interface FilePreviewProps {
  bundleId: string;
}

export function FilePreview({ bundleId }: FilePreviewProps) {
  const headingId = useId();
  const previewHeadingId = useId();
  const files = useQuery(bundleFilesQuery(bundleId));
  const [picked, setPicked] = useState<string | null>(null);
  const entries = files.data?.items ?? [];
  const path = picked ?? pickDefaultPreview(entries);
  const selected = entries.find((entry) => entry.path === path) ?? null;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-lg font-semibold">
          Files
        </h2>
        {files.data === undefined ? null : (
          <p className="text-sm text-muted-foreground">
            {pluralize(entries.length, "stored file")}. Text files can be previewed.
          </p>
        )}
      </div>
      {files.isPending ? (
        <div role="status" aria-busy="true" className="flex flex-col gap-2">
          <span className="sr-only">Loading the file list</span>
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : files.isError ? (
        <ErrorState
          title="Could not load the file list"
          description={describeApiError(files.error)}
          requestId={readRequestId(files.error)}
          onRetry={() => void files.refetch()}
          className="py-8"
        />
      ) : entries.length === 0 ? (
        <EmptyState
          title="No files stored"
          description="This version has no stored files."
          icon={FileText}
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_1fr] lg:items-start">
          <div className="overflow-hidden rounded-xl border">
            <Table aria-label="Stored files">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Path</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead>
                    <span className="sr-only">Preview</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <TableRow key={entry.path} data-selected={entry.path === path}>
                    <TableCell className="font-mono text-xs break-all whitespace-normal">
                      {entry.path}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {formatBytes(entry.size_bytes)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant={entry.path === path ? "secondary" : "ghost"}
                        size="sm"
                        aria-pressed={entry.path === path}
                        aria-label={`Preview ${entry.path}`}
                        onClick={() => setPicked(entry.path)}
                      >
                        <Eye aria-hidden="true" data-icon="inline-start" />
                        Preview
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {selected === null ? null : (
            <PreviewPanel
              key={selected.path}
              bundleId={bundleId}
              entry={selected}
              headingId={previewHeadingId}
            />
          )}
        </div>
      )}
    </section>
  );
}
