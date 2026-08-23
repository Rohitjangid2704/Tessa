"use client";

import { useQuery } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import type { MutationSummary } from "@/lib/api/types";
import { mutationRoutes } from "@/lib/routes";
import { loadStateOf } from "../load-state";
import { describeMutationHeadline, describeSurvivors } from "../mutation-headline";
import { mutationSummaryQuery } from "../queries";
import { KpiTile } from "./kpi-tile";

export type MutationCardProps = {
  targetId: string | null;
  className?: string;
};

function Survivors({ survivors }: { survivors: MutationSummary["survivors"] }) {
  return (
    <ul
      data-slot="mutation-survivors"
      aria-label="Surviving mutants"
      className="flex flex-col gap-2"
    >
      {survivors.map((survivor) => (
        <li key={survivor.mutant_id} className="flex flex-col gap-1 rounded-lg border p-2">
          <span className="font-mono text-sm font-medium wrap-anywhere">{survivor.name}</span>
          {survivor.invariant_ids.length === 0 ? null : (
            <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              Expected to be caught by
              {survivor.invariant_ids.map((invariantId) => (
                <Badge key={invariantId} variant="outline" className="font-mono">
                  {invariantId}
                </Badge>
              ))}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function MutationDetail({ summary }: { summary: MutationSummary }) {
  const survivorNames = summary.survivors.map((survivor) => survivor.name);
  if (summary.total === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Copy the Mutants prompt on the mutation page, let Claude Code build the broken branches,
        then register them to measure how many bugs the suite catches.
      </p>
    );
  }
  if (survivorNames.length > 0) {
    return (
      <>
        <p className="text-sm text-muted-foreground">
          {describeSurvivors(survivorNames)}. No invariant caught{" "}
          {survivorNames.length === 1 ? "it" : "them"}.
        </p>
        <Survivors survivors={summary.survivors} />
      </>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      {summary.killed === summary.total
        ? "No survivors in the last mutation runs."
        : "Some mutants were neither killed nor survived. Check the last runs."}
    </p>
  );
}

function MutationBody({ summary }: { summary: MutationSummary }) {
  const headline = describeMutationHeadline(summary);
  return (
    <div data-slot="mutation-body" className="flex flex-col gap-3">
      <p data-slot="mutation-headline" className="text-lg font-semibold">
        {headline.text}
      </p>
      <MutationDetail summary={summary} />
    </div>
  );
}

export function MutationCard({ targetId, className }: MutationCardProps) {
  const summary = useQuery({ ...mutationSummaryQuery(targetId ?? ""), enabled: targetId !== null });
  const headline = summary.data === undefined ? null : describeMutationHeadline(summary.data);
  const footer = (
    <Link
      href={mutationRoutes.list(targetId)}
      className="font-medium underline-offset-4 hover:underline"
    >
      Open the mutation page
    </Link>
  );

  if (targetId === null) {
    return (
      <KpiTile
        title="Mutation power"
        icon={FlaskConical}
        footer={footer}
        className={className}
        data-tile="mutation"
      >
        <p className="text-sm text-muted-foreground">
          Choose a target to see which known bugs the suite catches.
        </p>
      </KpiTile>
    );
  }

  return (
    <KpiTile
      title="Mutation power"
      icon={FlaskConical}
      tone={headline?.tone}
      statusLabel={headline?.statusLabel}
      load={loadStateOf(summary)}
      footer={footer}
      className={className}
      data-tile="mutation"
    >
      {summary.data === undefined ? null : <MutationBody summary={summary.data} />}
    </KpiTile>
  );
}
