import type { RunReport } from "@/lib/api/types";
import { toFindingSummary } from "../factories/finding";
import { previousCompletedRun, sideOf } from "../handlers/run-stats";
import type { ApiContext } from "../handlers/api";
import type { RunEntry } from "../stage2/store";
import { stageTwo } from "../stage2/support";
import { toRun } from "../stage2/views";
import { buildRunDiff } from "../stage5/diff";
import { buildRunStats } from "../stage5/stats";
import { findingsStore } from "../stage5/support";

export const REPORT_HTML_TARGET_BYTES = 400 * 1024;

const ROW_COUNT_FLOOR = 50;

export function buildRunReport(context: ApiContext, entry: RunEntry): RunReport {
  const current = sideOf(context, entry);
  const against = previousCompletedRun(context, entry);
  const run = toRun(entry);
  const findings = findingsStore(context)
    .records.filter((record) => record.runIds.includes(entry.run.id))
    .map((record) => toFindingSummary(record.finding));
  const rows = stageTwo(context).scenariosOfRun(entry.run.id);
  return {
    run,
    stats: buildRunStats(entry, rows, current.openFindings),
    findings,
    diff: against === undefined ? null : buildRunDiff(current, sideOf(context, against)),
    config_snapshot: run.config_snapshot,
    generated_at: new Date().toISOString(),
  };
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const REPORT_STYLE =
  "body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#1a1a1a}h1{font-size:20px}" +
  "table{border-collapse:collapse;width:100%}td,th{border:1px solid #d4d4d4;padding:4px 8px;text-align:left}" +
  "th{background:#f4f4f5}.fail{color:#b91c1c}.pass{color:#15803d}.note{background:#fef9c3;padding:8px}";

function reportRow(index: number): string {
  const failed = index % 9 === 0;
  const label = failed ? "fail" : "pass";
  return (
    `<tr><td>${index + 1}</td><td>scenario-${index}-smart-log-read-open-maintenance</td>` +
    `<td>manager</td><td class="${label}">${label}</td>` +
    `<td>Answer text from the system under test, shown as plain text: &lt;b&gt;not bold&lt;/b&gt; ${index}</td></tr>`
  );
}

export function buildReportHtml(entry: RunEntry): string {
  const { run } = entry;
  const head =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<title>Run ${escapeHtml(run.id)} report</title><style>${REPORT_STYLE}</style></head><body>` +
    `<h1>Run report ${escapeHtml(run.id)}</h1>` +
    `<p class="note">This is a generated fake report. The script below must never run inside the app.</p>` +
    `<script>document.body.setAttribute("data-script-ran", "yes");</script>` +
    `<p>Status ${escapeHtml(run.status)}, ${run.counters.scenarios_total} scenarios.</p>` +
    `<table><thead><tr><th>#</th><th>Scenario</th><th>Role</th><th>Verdict</th><th>Evidence</th></tr></thead><tbody>`;
  const tail = `</tbody></table></body></html>`;
  const rows: string[] = [];
  let size = head.length + tail.length;
  let index = 0;
  while (size < REPORT_HTML_TARGET_BYTES || index < ROW_COUNT_FLOOR) {
    const row = reportRow(index);
    rows.push(row);
    size += row.length;
    index += 1;
  }
  return `${head}${rows.join("")}${tail}`;
}
