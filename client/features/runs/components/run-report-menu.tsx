"use client";

import { useMutation, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { ChevronDown, Download, Eye, FileJson, FileText } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { SandboxedFrame } from "@/components/sandboxed-frame";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { downloadAuthedFile, saveDownloadedFile, type DownloadedFile } from "@/lib/api/download";
import { describeApiError } from "@/lib/api/errors";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import type { Run } from "@/lib/api/types";
import {
  REPORT_ACCEPT,
  reportFallbackFilename,
  reportPath,
  runReportHtmlQuery,
  type ReportFormat,
} from "../report-queries";
import { isTerminalRunStatus } from "../run-status";

export type RunReportMenuProps = {
  run: Pick<Run, "id" | "status">;
};

type ReportViewerProps = {
  runId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type ReportViewerBodyProps = {
  runId: string;
  report: UseQueryResult<DownloadedFile, Error>;
};

function ReportViewerBody({ runId, report }: ReportViewerBodyProps) {
  if (report.isPending) {
    return (
      <div role="status" aria-busy="true" className="h-full p-3">
        <span className="sr-only">Loading the report</span>
        <Skeleton className="h-full w-full" />
      </div>
    );
  }
  if (report.isError) {
    const requestId = readRequestId(report.error);
    return (
      <div role="alert" className="flex flex-col items-start gap-2 p-4 text-sm">
        <p className="font-medium text-destructive">Could not load the report</p>
        <p className="text-muted-foreground">{describeApiError(report.error)}</p>
        {requestId === null ? null : (
          <p className="font-mono text-xs text-muted-foreground">Request ID: {requestId}</p>
        )}
        <Button type="button" variant="outline" size="sm" onClick={() => void report.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  return (
    <SandboxedFrame
      blob={report.data.blob}
      title={`Report of run ${runId}`}
      className="h-full w-full"
    />
  );
}

function ReportViewerDialog({ runId, open, onOpenChange }: ReportViewerProps) {
  const report = useQuery({ ...runReportHtmlQuery(runId), enabled: open });
  const file = report.data;

  function saveCurrentReport(): void {
    if (file !== undefined) {
      saveDownloadedFile(file);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-slot="report-viewer"
        className="flex h-[85vh] max-w-[calc(100%-2rem)] flex-col gap-3 sm:max-w-5xl"
      >
        <DialogHeader>
          <DialogTitle>Run report</DialogTitle>
          <DialogDescription>
            The report contains text from the system under test. It is shown in a sandbox: scripts
            do not run and the page cannot reach this app.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border">
          <ReportViewerBody runId={runId} report={report} />
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={file === undefined}
            onClick={saveCurrentReport}
          >
            <Download aria-hidden="true" data-icon="inline-start" />
            Download
          </Button>
          <DialogClose asChild>
            <Button type="button">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RunReportMenu({ run }: RunReportMenuProps) {
  const [viewing, setViewing] = useState(false);
  const download = useMutation({
    meta: INLINE_ERROR_META,
    mutationFn: (format: ReportFormat) =>
      downloadAuthedFile(reportPath(run.id, format), {
        accept: REPORT_ACCEPT[format],
        fallbackFilename: reportFallbackFilename(run.id, format),
      }),
    onSuccess: (file) => {
      toast.success(`Downloaded ${file.filename}`);
    },
    onError: (error) => {
      const requestId = readRequestId(error);
      toast.error("Could not download the report", {
        description:
          requestId === null
            ? describeApiError(error)
            : `${describeApiError(error)} (request ${requestId})`,
      });
    },
  });

  if (!isTerminalRunStatus(run.status)) {
    return (
      <span
        data-slot="run-report-unavailable"
        title="Reports are ready when the run finishes"
        className="inline-flex"
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled
          aria-label="Report, available when the run finishes"
        >
          <FileText aria-hidden="true" data-icon="inline-start" />
          Report
        </Button>
      </span>
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={download.isPending}
            data-slot="run-report-menu"
          >
            <FileText aria-hidden="true" data-icon="inline-start" />
            {download.isPending ? "Preparing" : "Report"}
            <ChevronDown aria-hidden="true" data-icon="inline-end" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuItem onSelect={() => setViewing(true)}>
            <Eye aria-hidden="true" />
            View the HTML report
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => download.mutate("html")}>
            <Download aria-hidden="true" />
            Download the HTML report
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => download.mutate("json")}>
            <FileJson aria-hidden="true" />
            Download the JSON report
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ReportViewerDialog runId={run.id} open={viewing} onOpenChange={setViewing} />
    </>
  );
}
