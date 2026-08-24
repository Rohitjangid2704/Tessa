"use client";

import { useId } from "react";
import { VerdictBadge } from "@/components/status/verdict-badge";
import type { DbCheck, Step } from "@/lib/api/types";
import { JsonText } from "./json-text";
import { OracleResultSheet } from "./oracle-result-sheet";

export type DbChecksPanelProps = {
  step: Pick<Step, "db_checks">;
};

const STATE_HINTS: Record<DbCheck["status"], string> = {
  pass: "The database matches what the step should have changed.",
  fail: "The database does not match what the step should have changed.",
  flaky: "The database matched on some reads and not on others.",
  uncertain: "The check could not decide. Nothing here proves the write happened or did not.",
  skipped: "The check was not run.",
};

function DbCheckItem({ check }: { check: DbCheck }) {
  const nameId = useId();
  return (
    <li
      data-slot="db-check"
      data-status={check.status}
      aria-labelledby={nameId}
      className="flex min-w-0 flex-col gap-3 rounded-xl border p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 id={nameId} className="font-mono text-sm font-medium break-all">
          {check.name}
        </h4>
        <VerdictBadge verdict={check.status} />
        {check.oracle_result_id === null ? null : (
          <span className="ml-auto">
            <OracleResultSheet
              resultId={check.oracle_result_id}
              subject={`database check ${check.name}`}
            />
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{STATE_HINTS[check.status]}</p>
      <dl className="grid gap-3 sm:grid-cols-2">
        <div data-slot="db-check-expected" className="flex min-w-0 flex-col gap-1">
          <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Expected
          </dt>
          <dd className="min-w-0 rounded-lg border bg-muted/30 p-2">
            <JsonText value={check.expected} label={`expected value of ${check.name}`} />
          </dd>
        </div>
        <div data-slot="db-check-actual" className="flex min-w-0 flex-col gap-1">
          <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Actual
          </dt>
          <dd className="min-w-0 rounded-lg border bg-muted/30 p-2">
            <JsonText value={check.actual} label={`actual value of ${check.name}`} />
          </dd>
        </div>
      </dl>
    </li>
  );
}

export function DbChecksPanel({ step }: DbChecksPanelProps) {
  const headingId = useId();
  const checks = step.db_checks;
  if (checks.length === 0) {
    return null;
  }
  return (
    <section
      aria-labelledby={headingId}
      data-slot="db-checks-panel"
      className="flex min-w-0 flex-col gap-3"
    >
      <h3 id={headingId} className="text-sm font-semibold">
        Database end state
      </h3>
      <p className="text-sm text-muted-foreground">
        What the truth database holds after this step, compared with what the step should have left
        there. Values come from the database and are shown as text only.
      </p>
      <ul aria-label="Database checks" className="flex flex-col gap-3">
        {checks.map((check, index) => (
          <DbCheckItem key={`${check.name}-${index}`} check={check} />
        ))}
      </ul>
    </section>
  );
}
