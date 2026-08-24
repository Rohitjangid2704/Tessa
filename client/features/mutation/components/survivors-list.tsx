"use client";

import { useQuery } from "@tanstack/react-query";
import { CircleCheck, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { indexInvariants, invariantCatalogQuery } from "@/features/invariants/queries";
import { coverageRoutes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import type { MutationSurvivor } from "../types";
import { MutationOutcomeBadge } from "./mutant-badges";

export type SurvivorsListProps = {
  survivors: readonly MutationSurvivor[];
  total: number;
  targetId: string;
  className?: string;
};

export function SurvivorsList({ survivors, total, targetId, className }: SurvivorsListProps) {
  const catalog = useQuery(invariantCatalogQuery());
  const titles = useMemo(() => indexInvariants(catalog.data ?? []), [catalog.data]);

  if (total === 0) {
    return null;
  }

  if (survivors.length === 0) {
    return (
      <p
        data-slot="survivors-none"
        className={cn("flex items-center gap-2 text-sm text-muted-foreground", className)}
      >
        <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
        No survivors. Every known bug was caught by at least one invariant in the latest runs.
      </p>
    );
  }

  return (
    <div data-slot="survivors-list" className={cn("flex flex-col gap-3", className)}>
      <ul aria-label="Surviving mutants" className="flex flex-col gap-3">
        {survivors.map((survivor) => (
          <li
            key={survivor.mutant_id}
            data-mutant-id={survivor.mutant_id}
            className="flex flex-col gap-2 rounded-xl border border-kpi-warn-fg/30 p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <MutationOutcomeBadge outcome="survived" />
              <span className="font-mono text-sm font-medium wrap-anywhere">{survivor.name}</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>Should have been caught by</span>
              {survivor.invariant_ids.length === 0 ? (
                <span>no invariant is named</span>
              ) : (
                survivor.invariant_ids.map((invariantId) => (
                  <Badge key={invariantId} variant="outline" title={invariantId}>
                    {titles.get(invariantId)?.title ?? invariantId}
                  </Badge>
                ))
              )}
              <span>and none of them failed.</span>
            </div>
          </li>
        ))}
      </ul>
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-kpi-warn-fg" />
        <span>
          A survivor means the suite has a blind spot. Look for cells on these invariants that have
          no scenario yet, then generate or author them.
        </span>
      </p>
      <div>
        <Button asChild variant="outline" size="sm">
          <Link href={coverageRoutes.map(targetId)}>Open the coverage map</Link>
        </Button>
      </div>
    </div>
  );
}
