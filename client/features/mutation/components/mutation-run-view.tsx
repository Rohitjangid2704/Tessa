"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { FlaskConical, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useId, useMemo } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useRunEvents, useRunStreamState } from "@/features/runs/use-run-stream";
import { mutationRoutes } from "@/lib/routes";
import {
  countOutcomes,
  describeOutcomeCounts,
  formatPower,
  mergeOutcomes,
  outcomeRows,
  outcomesFromEvents,
} from "../model";
import { mutantsQuery, mutationRunQuery, mutationRunsQuery } from "../queries";
import { OutcomeTable } from "./outcome-table";

export type MutationRunViewProps = {
  runId: string;
};

export function MutationRunView({ runId }: MutationRunViewProps) {
  const headingId = useId();
  const { run, isTerminal } = useRunStreamState();
  const { events } = useRunEvents();
  const targetId = run?.target_id ?? null;
  const history = useInfiniteQuery({ ...mutationRunsQuery(targetId ?? ""), enabled: targetId !== null });
  const mutants = useInfiniteQuery({ ...mutantsQuery(targetId ?? ""), enabled: targetId !== null });
  const record = history.data?.items.find((entry) => entry.run_id === runId) ?? null;
  const recordId = record?.id ?? null;
  const polled = useQuery({ ...mutationRunQuery(recordId ?? ""), enabled: recordId !== null });
  const mutant = mutants.data?.items.find((candidate) => candidate.id === record?.mutant_id);

  const rows = useMemo(() => {
    const stored = polled.data?.outcomes ?? record?.outcomes ?? [];
    const live = outcomesFromEvents(events, recordId);
    return outcomeRows(mutant?.expected_catchers ?? [], mergeOutcomes(stored, live));
  }, [events, mutant, polled.data, record, recordId]);

  const scoredItems = rows.flatMap((row) => (row.outcome === null ? [] : [row.outcome]));
  const counts = countOutcomes(scoredItems);
  const failed = run?.status === "failed";
  const power = polled.data?.power ?? record?.power ?? null;
  const survived = isTerminal && counts.survived > 0;
  const missingRecord = history.isSuccess && record === null && !history.hasNextPage;

  return (
    <section
      aria-labelledby={headingId}
      data-slot="mutation-run-view"
      data-terminal={isTerminal}
      className="flex flex-col gap-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={headingId} className="flex items-center gap-2 text-base font-semibold">
          <FlaskConical aria-hidden="true" className="size-4" />
          {mutant === undefined ? "Mutation run" : `Mutation run of ${mutant.name}`}
        </h2>
        {targetId === null ? null : (
          <Button asChild variant="outline" size="sm">
            <Link href={mutationRoutes.list(targetId)}>Back to the mutation page</Link>
          </Button>
        )}
      </div>
      {mutant === undefined ? null : (
        <p className="text-sm text-muted-foreground">
          Branch <span className="font-mono">{mutant.branch}</span>
          {mutant.base_url === null ? null : (
            <>
              , served at <span className="font-mono wrap-anywhere">{mutant.base_url}</span>
            </>
          )}
          .
        </p>
      )}
      <p role="status" data-slot="mutation-progress" className="text-sm text-muted-foreground">
        {isTerminal
          ? `Finished. ${describeOutcomeCounts(scoredItems)}. ${formatPower(power)}.`
          : `Scoring invariants: ${scoredItems.length} of ${rows.length} done.`}
      </p>
      {missingRecord ? (
        <Alert role="status" data-slot="no-mutation-record">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>No mutation record for this run</AlertTitle>
          <AlertDescription>
            The outcomes below come from the live stream only. They are not stored on a mutant.
          </AlertDescription>
        </Alert>
      ) : null}
      {failed ? (
        <Alert variant="destructive" data-slot="run-failed">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>The mutation run failed</AlertTitle>
          <AlertDescription>
            The run ended before every invariant was scored, so this mutant is not counted. Read
            the event log below for the reason, then run the mutant again.
          </AlertDescription>
        </Alert>
      ) : null}
      <OutcomeTable rows={rows} active={!isTerminal} />
      {survived ? (
        <p data-slot="run-survived" className="flex items-start gap-2 text-sm">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-kpi-warn-fg" />
          <span>
            {counts.survived} {counts.survived === 1 ? "invariant" : "invariants"} did not catch
            this mutant, so the suite has a blind spot for this bug.
          </span>
        </p>
      ) : null}
    </section>
  );
}
