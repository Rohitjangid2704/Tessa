import { queryOptions } from "@tanstack/react-query";
import { fetchAuthedFile } from "@/lib/api/download";
import { INLINE_ERROR_META } from "@/lib/api/query-client";
import { qk } from "@/lib/api/query-keys";

export const REPORT_HTML_STALE_TIME_MS = 60_000;

export const REPORT_HTML_GC_TIME_MS = 120_000;

export type ReportFormat = "json" | "html";

export function reportPath(runId: string, format: ReportFormat): string {
  const base = `/api/v1/runs/${encodeURIComponent(runId)}/report`;
  return format === "html" ? `${base}.html` : base;
}

export function reportFallbackFilename(runId: string, format: ReportFormat): string {
  return format === "html" ? `run-${runId}.html` : `run-${runId}-report.json`;
}

export const REPORT_ACCEPT: Record<ReportFormat, string> = {
  json: "application/json",
  html: "text/html",
};

export function runReportHtmlQuery(runId: string) {
  return queryOptions({
    queryKey: qk.runs.reportHtml(runId),
    queryFn: ({ signal }) =>
      fetchAuthedFile(reportPath(runId, "html"), {
        accept: REPORT_ACCEPT.html,
        fallbackFilename: reportFallbackFilename(runId, "html"),
        signal,
      }),
    staleTime: REPORT_HTML_STALE_TIME_MS,
    gcTime: REPORT_HTML_GC_TIME_MS,
    structuralSharing: false,
    meta: INLINE_ERROR_META,
  });
}
