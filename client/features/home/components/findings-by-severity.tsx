"use client";

import { Bug } from "lucide-react";
import Link from "next/link";
import { SeverityBadge } from "@/components/status/severity-badge";
import { SEVERITIES, type Severity } from "@/components/status/status-types";
import { SEVERITY_LABELS } from "@/features/findings/detail-schemas";
import { pluralize } from "@/features/findings/labels";
import type { SeverityCounts } from "@/lib/api/types";
import { findingRoutes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { loadStateOf, type DashboardQueryResult } from "../load-state";
import type { KpiTone } from "../mutation-headline";
import { KpiTile, KpiValue } from "./kpi-tile";

export type FindingsBySeverityProps = {
  targetId: string | null;
  dashboard: DashboardQueryResult;
};

export function totalOpenFindings(counts: SeverityCounts): number {
  return SEVERITIES.reduce((sum, severity) => sum + counts[severity], 0);
}

export type FindingsTone = {
  tone: KpiTone;
  statusLabel: string | undefined;
};

const NO_SIGNAL: FindingsTone = { tone: "neutral", statusLabel: undefined };

export function describeFindingsTone(counts: SeverityCounts): FindingsTone {
  if (counts.critical > 0) {
    return { tone: "bad", statusLabel: `${counts.critical} critical` };
  }
  if (counts.high > 0) {
    return { tone: "warn", statusLabel: `${counts.high} high` };
  }
  if (totalOpenFindings(counts) === 0) {
    return { tone: "good", statusLabel: "None open" };
  }
  return NO_SIGNAL;
}

type SeverityLinkProps = {
  severity: Severity;
  count: number;
  targetId: string | null;
};

function SeverityLink({ severity, count, targetId }: SeverityLinkProps) {
  const label = SEVERITY_LABELS[severity];
  return (
    <Link
      href={findingRoutes.list({ severity, target_id: targetId })}
      data-slot="severity-link"
      data-severity={severity}
      aria-label={`${label}: ${count} open ${pluralize(count, "finding")}. Open the findings board filtered to ${label.toLowerCase()}`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-4xl p-0.5 pr-2 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
        count === 0 && "opacity-70",
      )}
    >
      <SeverityBadge severity={severity} aria-hidden="true" />
      <span className="text-sm font-medium tabular-nums">{count}</span>
    </Link>
  );
}

export function FindingsBySeverity({ targetId, dashboard }: FindingsBySeverityProps) {
  const counts = dashboard.data?.open_findings_by_severity;
  const { tone, statusLabel } = counts === undefined ? NO_SIGNAL : describeFindingsTone(counts);

  return (
    <KpiTile
      title="Open findings"
      icon={Bug}
      tone={tone}
      statusLabel={statusLabel}
      load={loadStateOf(dashboard)}
      data-tile="findings"
    >
      {counts === undefined ? null : (
        <>
          <KpiValue value={totalOpenFindings(counts)} detail="Still open, by severity" />
          <ul aria-label="Open findings by severity" className="flex flex-wrap gap-1">
            {SEVERITIES.map((severity) => (
              <li key={severity}>
                <SeverityLink severity={severity} count={counts[severity]} targetId={targetId} />
              </li>
            ))}
          </ul>
        </>
      )}
    </KpiTile>
  );
}
