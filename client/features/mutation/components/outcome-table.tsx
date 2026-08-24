"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { indexInvariants, invariantCatalogQuery } from "@/features/invariants/queries";
import { scenarioHref } from "@/lib/routes";
import type { OutcomeRow } from "../model";
import { MutationOutcomeBadge, PendingOutcomeBadge } from "./mutant-badges";

const MAX_LISTED_CATCHERS = 3;
const SHORT_ID_LENGTH = 8;

export type OutcomeTableProps = {
  rows: readonly OutcomeRow[];
  active: boolean;
};

function CaughtBy({ scenarioIds }: { scenarioIds: readonly string[] }) {
  if (scenarioIds.length === 0) {
    return <span className="text-muted-foreground">No scenario failed</span>;
  }
  const listed = scenarioIds.slice(0, MAX_LISTED_CATCHERS);
  const hidden = scenarioIds.length - listed.length;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>
        {scenarioIds.length} {scenarioIds.length === 1 ? "scenario" : "scenarios"}
      </span>
      {listed.map((scenarioId) => (
        <Link
          key={scenarioId}
          href={scenarioHref(scenarioId)}
          className="font-mono text-xs underline underline-offset-3"
        >
          {scenarioId.slice(0, SHORT_ID_LENGTH)}
          <span className="sr-only"> (open the scenario)</span>
        </Link>
      ))}
      {hidden > 0 ? <span className="text-xs text-muted-foreground">and {hidden} more</span> : null}
    </span>
  );
}

function OutcomeCell({ row, active }: { row: OutcomeRow; active: boolean }) {
  if (row.outcome !== null) {
    return <MutationOutcomeBadge outcome={row.outcome.outcome} />;
  }
  return active ? <PendingOutcomeBadge /> : <MutationOutcomeBadge outcome={null} />;
}

export function OutcomeTable({ rows, active }: OutcomeTableProps) {
  const catalog = useQuery(invariantCatalogQuery());
  const titles = useMemo(() => indexInvariants(catalog.data ?? []), [catalog.data]);

  return (
    <Table aria-label="Outcome per invariant">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Invariant</TableHead>
          <TableHead>Outcome</TableHead>
          <TableHead>Caught by</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={3} className="text-muted-foreground">
              {active ? "Waiting for the first outcome." : "No invariant was scored."}
            </TableCell>
          </TableRow>
        ) : (
          rows.map((row) => (
            <TableRow
              key={row.invariantId}
              data-invariant-id={row.invariantId}
              data-outcome={row.outcome?.outcome ?? (active ? "pending" : "none")}
            >
              <TableCell>
                <span className="flex flex-col">
                  <span className="font-medium">
                    {titles.get(row.invariantId)?.title ?? row.invariantId}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">{row.invariantId}</span>
                </span>
              </TableCell>
              <TableCell>
                <OutcomeCell row={row} active={active} />
              </TableCell>
              <TableCell>
                {row.outcome === null ? (
                  <span className="text-muted-foreground">Not scored yet</span>
                ) : (
                  <CaughtBy scenarioIds={row.outcome.caught_by} />
                )}
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
