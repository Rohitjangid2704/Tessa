"use client";

import { useQuery } from "@tanstack/react-query";
import { ChartColumn, Table2, TriangleAlert } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Meter } from "@/components/meter";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { indexInvariants, invariantCatalogQuery } from "@/features/invariants/queries";
import { cn } from "@/lib/utils";
import type { MutationInvariantPower } from "../types";

const PERCENT = 100;

export type PowerChartProps = {
  rows: readonly MutationInvariantPower[];
  className?: string;
};

function killedShare(row: MutationInvariantPower): number | null {
  const scored = row.killed + row.survived;
  return scored === 0 ? null : row.killed / scored;
}

function describeShare(row: MutationInvariantPower): string {
  const share = killedShare(row);
  return share === null ? "Not scored" : `${Math.round(share * PERCENT)}%`;
}

function describeScored(row: MutationInvariantPower): string {
  return `${row.killed} of ${row.killed + row.survived} mutants killed`;
}

function SurvivedNote({ count }: { count: number }) {
  if (count === 0) {
    return <span className="text-muted-foreground">0 survived</span>;
  }
  return (
    <span className="inline-flex items-center gap-1 font-medium text-kpi-warn-fg">
      <TriangleAlert aria-hidden="true" className="size-3.5" />
      {count} survived
    </span>
  );
}

export function PowerChart({ rows, className }: PowerChartProps) {
  const tableId = useId();
  const [asTable, setAsTable] = useState(false);
  const catalog = useQuery(invariantCatalogQuery());
  const titles = useMemo(() => indexInvariants(catalog.data ?? []), [catalog.data]);

  if (rows.length === 0) {
    return (
      <p data-slot="power-chart-empty" className="text-sm text-muted-foreground">
        No invariant has been scored yet. Run a deployed mutant to see which invariants catch it.
      </p>
    );
  }

  const titleOf = (invariantId: string): string => titles.get(invariantId)?.title ?? invariantId;

  return (
    <div data-slot="power-chart" className={cn("flex flex-col gap-3", className)}>
      <div className="flex justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={asTable}
          aria-controls={tableId}
          onClick={() => setAsTable((current) => !current)}
        >
          {asTable ? (
            <ChartColumn aria-hidden="true" data-icon="inline-start" />
          ) : (
            <Table2 aria-hidden="true" data-icon="inline-start" />
          )}
          {asTable ? "Show as bars" : "Show as table"}
        </Button>
      </div>
      <div id={tableId}>
        {asTable ? (
          <Table aria-label="Mutation power per invariant">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Invariant</TableHead>
                <TableHead className="text-right">Killed</TableHead>
                <TableHead className="text-right">Survived</TableHead>
                <TableHead className="text-right">Share killed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.invariant_id} data-invariant-id={row.invariant_id}>
                  <TableCell>
                    <span className="flex flex-col">
                      <span className="font-medium">{titleOf(row.invariant_id)}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {row.invariant_id}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.killed}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    <SurvivedNote count={row.survived} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{describeShare(row)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <ul aria-label="Mutation power per invariant" className="flex flex-col gap-3">
            {rows.map((row) => (
              <li
                key={row.invariant_id}
                data-invariant-id={row.invariant_id}
                data-survived={row.survived}
                className="grid gap-2 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-center"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium wrap-break-word">
                    {titleOf(row.invariant_id)}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {row.invariant_id}
                  </span>
                </span>
                <Meter
                  value={killedShare(row)}
                  label={`${titleOf(row.invariant_id)}: share of mutants killed`}
                  valueText={describeScored(row)}
                  className={row.survived > 0 ? "bg-kpi-warn-fg/30" : undefined}
                />
                <span className="flex flex-wrap items-center gap-x-3 text-xs tabular-nums">
                  <span>{row.killed} killed</span>
                  <SurvivedNote count={row.survived} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
