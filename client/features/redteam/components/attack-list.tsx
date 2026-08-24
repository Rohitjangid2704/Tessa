"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { SearchX, Swords } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { DataTableFooter } from "@/components/data-table";
import { FilterBar, type FilterField } from "@/components/filter-bar";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { readRequestId } from "@/components/states/request-id";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { filterOptions } from "@/features/runs/labels";
import { describeApiError } from "@/lib/api/errors";
import type { AttackOutcome, RedTeamFamily } from "@/lib/api/types";
import { useHydrated } from "@/lib/use-hydrated";
import { ATTACK_OUTCOME_LABELS, ATTACK_OUTCOMES, roundLabel } from "../labels";
import { attacksQuery, type AttackFilters } from "../queries";
import { AttackRow } from "./attack-row";

const SKELETON_ROWS = 3;

type AttackFilterValues = {
  outcome: AttackOutcome[];
  family: string[];
};

export type AttackListProps = {
  runId: string;
  families: readonly RedTeamFamily[];
  familyTitleOf: (familyId: string) => string;
  roundIndexOf: (roundId: string) => number | null;
  runActive: boolean;
  pollMs: number | false;
};

function toQueryFilters(values: Partial<AttackFilterValues>): AttackFilters {
  return {
    ...(values.outcome === undefined ? {} : { outcome: values.outcome }),
    ...(values.family === undefined ? {} : { family: values.family }),
  };
}

export function AttackList({
  runId,
  families,
  familyTitleOf,
  roundIndexOf,
  runActive,
  pollMs,
}: AttackListProps) {
  const headingId = useId();
  const hydrated = useHydrated();
  const [values, setValues] = useState<Partial<AttackFilterValues>>({});
  const query = useInfiniteQuery(attacksQuery(runId, toQueryFilters(values), pollMs));
  const activeCount = (values.outcome === undefined ? 0 : 1) + (values.family === undefined ? 0 : 1);

  const fields: readonly FilterField<"outcome" | "family">[] = [
    {
      type: "multi",
      key: "outcome",
      label: "Outcome",
      options: filterOptions(ATTACK_OUTCOMES, ATTACK_OUTCOME_LABELS),
    },
    {
      type: "multi",
      key: "family",
      label: "Family",
      options: families.map((family) => ({ value: family.id, label: family.title })),
    },
  ];

  const items = hydrated ? (query.data?.items ?? []) : [];

  let body: ReactNode;
  if (!hydrated || query.isPending) {
    body = (
      <div role="status" aria-busy="true" className="flex flex-col gap-2">
        <span className="sr-only">Loading the attacks</span>
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <Skeleton key={index} className="h-16 w-full" />
        ))}
      </div>
    );
  } else if (query.isError && query.data === undefined) {
    body = (
      <ErrorState
        title="Could not load the attacks"
        description={describeApiError(query.error)}
        requestId={readRequestId(query.error)}
        onRetry={() => void query.refetch()}
      />
    );
  } else if (items.length === 0 && !query.hasNextPage) {
    body =
      activeCount > 0 ? (
        <EmptyState
          icon={SearchX}
          title="No attacks match these filters"
          description="Clear the filters to see every attack of this run."
          action={
            <Button type="button" variant="outline" onClick={() => setValues({})}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <EmptyState
          icon={Swords}
          title="No attacks yet"
          description={
            runActive
              ? "Attacks appear here as each round runs."
              : "This run did not record any attack."
          }
        />
      );
  } else {
    body = (
      <>
        <ul aria-label="Attacks" className="flex flex-col gap-2">
          {items.map((attack) => {
            const index = roundIndexOf(attack.round_id);
            return (
              <AttackRow
                key={attack.id}
                attack={attack}
                familyTitle={familyTitleOf(attack.family)}
                roundLabel={index === null ? null : roundLabel(index)}
              />
            );
          })}
        </ul>
        <DataTableFooter
          noun="attack"
          loadedCount={items.length}
          total={query.data?.total}
          hasNextPage={query.hasNextPage}
          isFetchingNextPage={query.isFetchingNextPage}
          onLoadMore={() => void query.fetchNextPage()}
        />
      </>
    );
  }

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={hydrated && query.isFetching && !query.isFetchingNextPage}
      data-slot="attack-list"
      className="flex flex-col gap-3"
    >
      <h2 id={headingId} className="text-base font-semibold">
        Attacks
      </h2>
      <FilterBar
        label="Filter the attacks"
        fields={fields}
        values={values}
        onChange={(patch) => setValues((current) => ({ ...current, ...patch }))}
        onReset={() => setValues({})}
        activeCount={activeCount}
      />
      {body}
    </section>
  );
}
