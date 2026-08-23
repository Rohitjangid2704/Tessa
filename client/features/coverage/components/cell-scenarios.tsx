"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import Link from "next/link";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SCENARIO_ORIGIN_LABELS } from "@/features/scenarios/labels";
import { ScenarioStatusBadge } from "@/features/scenarios/components/scenario-status-badge";
import { describeApiError } from "@/lib/api/errors";
import { scenarioRoutes } from "@/lib/routes";
import { cellScenariosQuery } from "../queries";

export interface CellScenariosProps {
  targetId: string;
  cellId: string;
}

const SKELETON_ROWS = 3;

export function CellScenarios({ targetId, cellId }: CellScenariosProps) {
  const query = useInfiniteQuery(cellScenariosQuery(targetId, cellId));

  if (query.isPending) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-2">
        <span className="sr-only">Loading the scenarios of this cell</span>
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <Skeleton key={index} aria-hidden="true" className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (query.isError) {
    const requestId = readRequestId(query.error);
    return (
      <div role="alert" className="flex flex-col gap-2 text-sm">
        <p>Could not load the scenarios of this cell. {describeApiError(query.error)}</p>
        {requestId === null ? null : (
          <p className="font-mono text-xs text-muted-foreground">Request ID: {requestId}</p>
        )}
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }

  const { items, total } = query.data;
  if (items.length === 0) {
    return (
      <p data-slot="cell-scenarios-empty" className="text-sm text-muted-foreground">
        No scenarios in this cell yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-slot="cell-scenarios">
      <p className="text-xs text-muted-foreground">
        {total === null ? items.length : total} {(total ?? items.length) === 1 ? "scenario" : "scenarios"}
      </p>
      <ul className="flex flex-col gap-2">
        {items.map((scenario) => (
          <li
            key={scenario.id}
            className="flex flex-col gap-1.5 rounded-lg border px-3 py-2 text-sm"
          >
            <Link
              href={scenarioRoutes.detail(scenario.id)}
              className="font-medium underline-offset-4 hover:underline"
            >
              {scenario.title}
            </Link>
            <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <ScenarioStatusBadge status={scenario.status} />
              <span>{SCENARIO_ORIGIN_LABELS[scenario.origin]}</span>
              <span>Version {scenario.version}</span>
            </span>
          </li>
        ))}
      </ul>
      {query.hasNextPage ? (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={query.isFetchingNextPage}
            aria-busy={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? (
              <LoaderCircle aria-hidden="true" data-icon="inline-start" className="animate-spin" />
            ) : null}
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
