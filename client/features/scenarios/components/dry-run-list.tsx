import Link from "next/link";
import { VerdictBadge } from "@/components/status/verdict-badge";
import type { ScenarioDryRun } from "@/lib/api/types";
import { runRoutes } from "@/lib/routes";

const SHORT_ID_LENGTH = 8;

export type DryRunListProps = {
  dryRuns: readonly ScenarioDryRun[];
};

export function DryRunList({ dryRuns }: DryRunListProps) {
  if (dryRuns.length === 0) {
    return (
      <p data-slot="dry-run-list" className="text-sm text-muted-foreground">
        No dry runs recorded. Dry runs are skipped on a production target and when nothing needed
        one.
      </p>
    );
  }
  return (
    <ol data-slot="dry-run-list" aria-label="Dry runs" className="flex flex-col gap-1.5">
      {dryRuns.map((dryRun, index) => (
        <li
          key={`${dryRun.run_id}-${dryRun.run_scenario_id}`}
          className="flex flex-wrap items-center gap-2 text-sm"
        >
          <span className="text-muted-foreground">Dry run {index + 1}</span>
          <VerdictBadge verdict={dryRun.verdict.status} />
          <Link
            href={runRoutes.detail(dryRun.run_id)}
            className="font-mono text-xs underline-offset-4 hover:underline"
          >
            Run {dryRun.run_id.slice(0, SHORT_ID_LENGTH)}
          </Link>
          {dryRun.verdict.reason === null ? null : (
            <span className="min-w-0 text-xs wrap-break-word text-muted-foreground">
              {dryRun.verdict.reason}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
