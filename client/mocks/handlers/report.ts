import { http } from "msw";
import { conflict } from "../factories/errors";
import { QueryReader } from "../factories/pagination";
import { pathUuid } from "../stage1/support";
import { isTerminal, requireRunEntry } from "../stage2/support";
import { buildReportHtml, buildRunReport } from "../stage8/report-data";
import { api, jsonResponse, requireUser, type ApiContext } from "./api";

function requireFinishedRun(context: ApiContext) {
  const entry = requireRunEntry(context, pathUuid(context, "run_id"));
  if (!isTerminal(entry.run.status)) {
    throw conflict("report_not_ready", "The report is available once the run has finished");
  }
  return entry;
}

async function readRunReport(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  new QueryReader(context.url.searchParams).finish();
  return jsonResponse(buildRunReport(context, requireFinishedRun(context)));
}

async function readRunReportHtml(context: ApiContext): Promise<Response> {
  await requireUser(context, "viewer");
  new QueryReader(context.url.searchParams).finish();
  const entry = requireFinishedRun(context);
  return new Response(buildReportHtml(entry), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "sandbox",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `inline; filename="run-${entry.run.id}.html"`,
    },
  });
}

export const reportHandlers = [
  http.get("*/api/v1/runs/:run_id/report.html", api(readRunReportHtml)),
  http.get("*/api/v1/runs/:run_id/report", api(readRunReport)),
];
