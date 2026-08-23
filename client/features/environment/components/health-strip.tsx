import { DateTime } from "@/components/date-time";
import { HealthTick } from "@/components/status/health-tick";
import { cn } from "@/lib/utils";
import type { HealthCheckStatus, HealthReport, HealthReportInterface } from "../types";

const TRUTH_SOURCE_KIND = "truth_source";
const SUMMARY_ORDER: readonly HealthCheckStatus[] = ["ok", "failed", "skipped", "unchecked"];

export interface HealthStripProps {
  report: HealthReport;
  isRunning?: boolean;
  className?: string;
}

function describeKind(kind: string): string {
  return kind === TRUTH_SOURCE_KIND ? "truth source" : kind;
}

export function summarizeHealth(interfaces: readonly HealthReportInterface[]): string {
  const parts = SUMMARY_ORDER.flatMap((status) => {
    const count = interfaces.filter((entry) => entry.status === status).length;
    return count === 0 ? [] : [`${count} ${status === "ok" ? "ok" : status}`];
  });
  return parts.length === 0 ? "nothing checked" : parts.join(", ");
}

function messageTone(status: HealthCheckStatus): string {
  return status === "failed" ? "text-destructive" : "text-muted-foreground";
}

function HealthRow({ entry }: { entry: HealthReportInterface }) {
  return (
    <li
      data-slot="health-row"
      data-interface={entry.interface_id}
      data-status={entry.status}
      className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start sm:justify-between"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-mono text-sm font-medium break-all">{entry.interface_id}</span>
          <span className="text-xs text-muted-foreground">{describeKind(entry.kind)}</span>
        </div>
        {entry.message ? (
          <p className={cn("text-sm", messageTone(entry.status))}>{entry.message}</p>
        ) : null}
        {entry.variables.length > 0 ? (
          <p className="text-xs break-words text-muted-foreground">
            Uses <span className="font-mono">{entry.variables.join(", ")}</span>
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {entry.latency_ms === null || entry.latency_ms === undefined ? null : (
          <span className="text-xs text-muted-foreground tabular-nums">{entry.latency_ms} ms</span>
        )}
        <HealthTick status={entry.status} />
      </div>
    </li>
  );
}

export function HealthStrip({ report, isRunning = false, className }: HealthStripProps) {
  return (
    <div
      data-slot="health-strip"
      aria-busy={isRunning}
      className={cn("flex flex-col gap-3", className)}
    >
      <p className="text-sm text-muted-foreground">
        {report.checked_at === null ? (
          "No health check has run yet."
        ) : (
          <>
            Last checked <DateTime value={report.checked_at} />,{" "}
            {summarizeHealth(report.interfaces)}
          </>
        )}
      </p>
      {report.interfaces.length === 0 ? null : (
        <ul aria-label="Interface health" className="divide-y rounded-xl border">
          {report.interfaces.map((entry) => (
            <HealthRow key={entry.interface_id} entry={entry} />
          ))}
        </ul>
      )}
    </div>
  );
}
